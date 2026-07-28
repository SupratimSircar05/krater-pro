import { randomUUID } from "node:crypto";
import {
  sandboxRequestDigest,
  validateApproval,
  validateSandboxRequest,
} from "./canonical.js";
import {
  boundProcessOutput,
  emptyBoundedOutput,
} from "./output.js";
import {
  unverifiedPlatformCapabilities,
  validateSecureContainment,
} from "./platform.js";
import type {
  NativeAdapterExecutionResult,
  PlatformCapabilityReport,
  SandboxExecutionReceipt,
  SandboxExecutionRequest,
  SandboxPlan,
  SandboxSupervisorOptions,
} from "./types.js";

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Native sandbox adapter failed.";
  return error.message
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "[REDACTED]")
    .replace(
      /(\b(?:api[_-]?key|password|secret|token|authorization)\b\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 512);
}

function receiptArguments(
  request: SandboxExecutionRequest,
): readonly string[] {
  const sensitive = new Set(request.command.sensitiveArgumentIndexes ?? []);
  let redactNext = false;
  return request.command.arguments.map((argument, index) => {
    const namedSecret =
      /^--?(?:api[-_]?key|authorization|password|secret|token)$/i.test(argument);
    const inlineSecret =
      /^--?(?:api[-_]?key|authorization|password|secret|token)=/i.test(argument);
    const shouldRedact = sensitive.has(index) || redactNext || inlineSecret;
    redactNext = namedSecret;
    if (shouldRedact) {
      if (inlineSecret) return `${argument.slice(0, argument.indexOf("=") + 1)}[REDACTED]`;
      return "[REDACTED]";
    }
    return argument
      .replace(/\b(Bearer|Basic)\s+\S+/gi, "[REDACTED]")
      .replace(/\b(?:sk|pk|kr)[_-][A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
  });
}

export class SandboxSupervisor {
  readonly #adapter: SandboxSupervisorOptions["adapter"];
  readonly #platform: NodeJS.Platform;
  readonly #now: () => Date;
  readonly #createExecutionId: () => string;

  constructor(options: SandboxSupervisorOptions = {}) {
    this.#adapter = options.adapter;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => new Date());
    this.#createExecutionId = options.createExecutionId ?? randomUUID;
  }

  async capabilities(): Promise<PlatformCapabilityReport> {
    if (!this.#adapter) return unverifiedPlatformCapabilities(this.#platform);
    try {
      const report = await this.#adapter.probe(this.#platform);
      if (report.platform !== this.#platform) {
        const fallback = unverifiedPlatformCapabilities(this.#platform);
        return {
          ...fallback,
          adapterId: this.#adapter.id,
          reason: `Native adapter returned capabilities for ${report.platform}, not ${this.#platform}.`,
        };
      }
      return report.adapterId
        ? report
        : { ...report, adapterId: this.#adapter.id };
    } catch (error) {
      const fallback = unverifiedPlatformCapabilities(this.#platform);
      return {
        ...fallback,
        adapterId: this.#adapter.id,
        reason: `Native adapter probe failed: ${safeErrorMessage(error)}`,
      };
    }
  }

  async plan(request: SandboxExecutionRequest): Promise<SandboxPlan> {
    validateSandboxRequest(request);
    const executionId = request.id?.trim() || this.#createExecutionId();
    const requestDigest = sandboxRequestDigest(request);
    const capabilityReport = await this.capabilities();
    const containment = validateSecureContainment(capabilityReport, request);

    if (containment.secure) {
      if (!this.#adapter) {
        return {
          decision: "refused",
          executionId,
          requestDigest,
          capabilityReport,
          reason: "A verified native adapter is required to execute this command.",
        };
      }
      return {
        decision: "ready",
        executionId,
        containment: "secure",
        requestDigest,
        capabilityReport,
      };
    }

    if (request.mode === "unattended") {
      return {
        decision: "refused",
        executionId,
        requestDigest,
        capabilityReport,
        reason: `Unattended execution is fail-closed: ${containment.reason}`,
      };
    }

    const approval = validateApproval(request.approval, requestDigest, this.#now());
    if (!approval.valid) {
      return {
        decision: "approval_required",
        executionId,
        requestDigest,
        capabilityReport,
        reason: `${containment.reason} ${approval.reason}`,
      };
    }
    if (!this.#adapter || !capabilityReport.supportsApprovedUncontainedExecution) {
      return {
        decision: "refused",
        executionId,
        requestDigest,
        capabilityReport,
        reason:
          "The adapter cannot perform explicitly approved fallback execution on this platform.",
      };
    }
    return {
      decision: "ready",
      executionId,
      containment: "approved_uncontained",
      requestDigest,
      capabilityReport,
    };
  }

  async execute(
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionReceipt> {
    const plan = await this.plan(request);
    const started = this.#now();
    if (plan.decision !== "ready") {
      return this.#nonExecutionReceipt(request, plan, started);
    }
    if (!this.#adapter) {
      return this.#nonExecutionReceipt(
        request,
        {
          ...plan,
          decision: "refused",
          reason: "A native adapter is required.",
        },
        started,
      );
    }

    const runPromise = this.#adapter.run({
      executionId: plan.executionId,
      containment: plan.containment,
      command: request.command,
      resources: request.resources,
      network: request.network,
      limits: request.limits,
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"wall_time">((resolve) => {
      timer = setTimeout(() => resolve("wall_time"), request.limits.wallTimeMs);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([runPromise, timeout]);
      if (outcome === "wall_time") {
        void runPromise.catch(() => undefined);
        let cancellationReason: string | undefined;
        try {
          await this.#adapter.cancel(plan.executionId, "wall_time");
        } catch (error) {
          cancellationReason = ` Native cancellation failed: ${safeErrorMessage(error)}`;
        }
        return this.#receipt(
          request,
          plan,
          started,
          undefined,
          "timed_out",
          `Wall-time limit was reached.${cancellationReason ?? ""}`,
          "wall_time",
        );
      }
      if (timer) clearTimeout(timer);
      return this.#completedReceipt(request, plan, started, outcome);
    } catch (error) {
      if (timer) clearTimeout(timer);
      return this.#receipt(
        request,
        plan,
        started,
        undefined,
        "adapter_error",
        safeErrorMessage(error),
      );
    }
  }

  #completedReceipt(
    request: SandboxExecutionRequest,
    plan: Extract<SandboxPlan, { decision: "ready" }>,
    started: Date,
    result: NativeAdapterExecutionResult,
  ): SandboxExecutionReceipt {
    let status: SandboxExecutionReceipt["status"];
    let reason: string | undefined;
    const boundedOutput = boundProcessOutput(
      result.output,
      request.limits.outputBytes,
      result.outputBytesObserved,
    );
    const reportedLimitViolation =
      boundedOutput.truncated ||
      (result.resourceUsage?.cpuTimeMs ?? 0) > request.limits.cpuTimeMs ||
      (result.resourceUsage?.peakMemoryBytes ?? 0) > request.limits.memoryBytes ||
      (result.resourceUsage?.peakProcessCount ?? 0) > request.limits.processCount;
    if (result.terminationReason === "wall_time") {
      status = "timed_out";
    } else if (
      result.terminationReason === "cpu_limit" ||
      result.terminationReason === "memory_limit" ||
      result.terminationReason === "process_limit" ||
      result.terminationReason === "output_limit"
    ) {
      status = "resource_limited";
    } else if (reportedLimitViolation) {
      status = "resource_limited";
      reason =
        "The adapter reported output or resource use above the configured ceiling.";
    } else if (result.exitCode === 0 && result.terminationReason === "exit") {
      status = "completed";
    } else {
      status = "failed";
    }
    return this.#receipt(
      request,
      plan,
      started,
      result,
      status,
      reason,
      result.terminationReason,
    );
  }

  #nonExecutionReceipt(
    request: SandboxExecutionRequest,
    plan: Exclude<SandboxPlan, { decision: "ready" }>,
    started: Date,
  ): SandboxExecutionReceipt {
    return this.#receipt(
      request,
      plan,
      started,
      undefined,
      plan.decision,
      plan.reason,
    );
  }

  #receipt(
    request: SandboxExecutionRequest,
    plan: SandboxPlan,
    started: Date,
    result: NativeAdapterExecutionResult | undefined,
    status: SandboxExecutionReceipt["status"],
    reason?: string,
    terminationReason?: SandboxExecutionReceipt["terminationReason"],
  ): SandboxExecutionReceipt {
    const completed = this.#now();
    return {
      schemaVersion: 1,
      executionId: plan.executionId,
      requestDigest: plan.requestDigest,
      status,
      containment: plan.decision === "ready" ? plan.containment : "none",
      capabilityReport: plan.capabilityReport,
      command: {
        executable: request.command.executable,
        arguments: receiptArguments(request),
        workingDirectory: request.command.workingDirectory,
      },
      networkPolicy: request.network.policy,
      limits: request.limits,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      exitCode: result?.exitCode ?? null,
      ...(result?.signal ? { signal: result.signal } : {}),
      ...(terminationReason ? { terminationReason } : {}),
      output: result
        ? boundProcessOutput(
            result.output,
            request.limits.outputBytes,
            result.outputBytesObserved,
          )
        : emptyBoundedOutput(),
      ...(result?.resourceUsage ? { resourceUsage: result.resourceUsage } : {}),
      ...(reason ? { reason } : {}),
    };
  }
}
