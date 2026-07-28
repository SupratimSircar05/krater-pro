import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_CHARS,
  DEFAULT_HOST,
  DEFAULT_MODEL,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PORT,
  DEFAULT_RESPONSE_STYLE,
  DEFAULT_TOOL_OUTPUT_CHARS,
  DEFAULT_SESSION_TOKEN_BUDGET,
  loadConfig,
  requireApiKey,
} from "./config.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "krater-config-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("loadConfig", () => {
  it("uses defaults and reports a missing key when no configuration is present", async () => {
    const cwd = await temporaryDirectory();

    const config = loadConfig({ cwd }, {});

    expect(config).toEqual({
      apiKey: undefined,
      apiKeySource: "missing",
      baseURL: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      modelSource: "default",
      cwd: await realpath(cwd),
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      contextChars: DEFAULT_CONTEXT_CHARS,
      toolOutputChars: DEFAULT_TOOL_OUTPUT_CHARS,
      responseStyle: DEFAULT_RESPONSE_STYLE,
      maxSteps: DEFAULT_MAX_STEPS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      sessionTokenBudget: DEFAULT_SESSION_TOKEN_BUDGET,
    });
  });

  it("loads Krater settings from the selected workspace .env file", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, ".env"),
      [
        "KRATER_API_KEY=kr_file",
        "KRATER_BASE_URL=https://file.krater.test/v1///",
        "KRATER_MODEL=file/model",
        "KRATER_PORT=4401",
        "KRATER_HOST=localhost",
        "KRATER_CONTEXT_CHARS=150000",
        "KRATER_TOOL_OUTPUT_CHARS=24000",
        "KRATER_RESPONSE_STYLE=standard",
        "KRATER_MAX_STEPS=64",
        "KRATER_MAX_OUTPUT_TOKENS=12288",
        "KRATER_SESSION_TOKEN_BUDGET=300000",
      ].join("\n"),
    );

    const config = loadConfig({ cwd }, {});

    expect(config.apiKey).toBe("kr_file");
    expect(config.apiKeySource).toBe(".env");
    expect(config.baseURL).toBe("https://file.krater.test/v1");
    expect(config.model).toBe("file/model");
    expect(config.modelSource).toBe(".env");
    expect(config.port).toBe(4401);
    expect(config.host).toBe("localhost");
    expect(config.contextChars).toBe(150_000);
    expect(config.toolOutputChars).toBe(24_000);
    expect(config.responseStyle).toBe("standard");
    expect(config.maxSteps).toBe(64);
    expect(config.maxOutputTokens).toBe(12_288);
    expect(config.sessionTokenBudget).toBe(300_000);
  });

  it("applies command overrides before process environment and .env values", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, ".env"),
      [
        "KRATER_API_KEY=kr_file",
        "KRATER_BASE_URL=https://file.krater.test/v1",
        "KRATER_MODEL=file/model",
        "KRATER_PORT=4401",
        "KRATER_HOST=file-host",
      ].join("\n"),
    );
    const environment: NodeJS.ProcessEnv = {
      KRATER_API_KEY: "kr_environment",
      KRATER_BASE_URL: "https://environment.krater.test/v1",
      KRATER_MODEL: "environment/model",
      KRATER_PORT: "4402",
      KRATER_HOST: "environment-host",
      KRATER_CONTEXT_CHARS: "160000",
      KRATER_TOOL_OUTPUT_CHARS: "25000",
      KRATER_RESPONSE_STYLE: "standard",
      KRATER_MAX_STEPS: "72",
      KRATER_MAX_OUTPUT_TOKENS: "10000",
      KRATER_SESSION_TOKEN_BUDGET: "280000",
    };

    const config = loadConfig(
      {
        cwd,
        apiKey: " kr_command ",
        baseURL: "https://command.krater.test/v1/",
        model: "command/model",
        port: 4403,
        host: "command-host",
        contextChars: 170_000,
        toolOutputChars: 26_000,
        responseStyle: "concise",
        maxSteps: 80,
        maxOutputTokens: 11_000,
        sessionTokenBudget: 290_000,
      },
      environment,
    );

    expect(config.apiKey).toBe("kr_command");
    expect(config.apiKeySource).toBe("command");
    expect(config.baseURL).toBe("https://command.krater.test/v1");
    expect(config.model).toBe("command/model");
    expect(config.modelSource).toBe("command");
    expect(config.port).toBe(4403);
    expect(config.host).toBe("command-host");
    expect(config.contextChars).toBe(170_000);
    expect(config.toolOutputChars).toBe(26_000);
    expect(config.responseStyle).toBe("concise");
    expect(config.maxSteps).toBe(80);
    expect(config.maxOutputTokens).toBe(11_000);
    expect(config.sessionTokenBudget).toBe(290_000);
  });

  it("falls back to environment configuration when command strings are blank", async () => {
    const cwd = await temporaryDirectory();
    const config = loadConfig(
      {
        cwd,
        apiKey: " ",
        baseURL: "\t",
        model: "",
        host: " ",
      },
      {
        KRATER_API_KEY: "kr_environment",
        KRATER_BASE_URL: "https://environment.krater.test/v1",
        KRATER_MODEL: "environment/model",
        KRATER_HOST: "environment-host",
      },
    );

    expect(config.apiKey).toBe("kr_environment");
    expect(config.apiKeySource).toBe("environment");
    expect(config.baseURL).toBe("https://environment.krater.test/v1");
    expect(config.model).toBe("environment/model");
    expect(config.modelSource).toBe("environment");
    expect(config.host).toBe("environment-host");
  });

  it("resolves a host credential handle before the plaintext .env fallback", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, ".env"),
      "KRATER_API_KEY=file-value\nKRATER_MODEL=auto\n",
    );
    const storedValue = ["stored", "credential", "value"].join("-");

    const config = loadConfig(
      { cwd },
      {},
      { readStoredCredential: () => storedValue },
    );

    expect(config.apiKey).toBe(storedValue);
    expect(config.apiKeySource).toBe("credential_store");
  });

  it.each(["0", "65536", "-1", "4317junk"])(
    "rejects invalid KRATER_PORT value %s",
    async (port) => {
      const cwd = await temporaryDirectory();

      expect(() => loadConfig({ cwd }, { KRATER_PORT: port })).toThrow(/Invalid port/);
    },
  );

  it.each([0, 65_536, Number.NaN])(
    "validates numeric command port override %s",
    async (port) => {
      const cwd = await temporaryDirectory();

      expect(() => loadConfig({ cwd, port }, {})).toThrow(/Invalid port/);
    },
  );

  it("rejects non-HTTP base URLs", async () => {
    const cwd = await temporaryDirectory();

    expect(() => loadConfig({ cwd, baseURL: "file:///tmp/krater" }, {})).toThrow(
      /must use http or https/,
    );
  });

  it("allows plaintext HTTP only for local development endpoints", async () => {
    const cwd = await temporaryDirectory();

    expect(
      loadConfig({ cwd, baseURL: "http://127.0.0.1:9444/v1" }, {}).baseURL,
    ).toBe("http://127.0.0.1:9444/v1");
    expect(
      loadConfig({ cwd, baseURL: "http://localhost:9444/v1" }, {}).baseURL,
    ).toBe("http://localhost:9444/v1");
    expect(() =>
      loadConfig({ cwd, baseURL: "http://api.example.test/v1" }, {}),
    ).toThrow(/must use HTTPS/);
  });

  it.each([
    "https://user:password@api.example.test/v1",
    "https://api.example.test/v1?token=secret",
    "https://api.example.test/v1#private",
  ])("rejects unsafe base URL components in %s", async (baseURL) => {
    const cwd = await temporaryDirectory();
    expect(() => loadConfig({ cwd, baseURL }, {})).toThrow(
      /embedded credentials|query string or fragment/,
    );
  });

  it.each([
    ["KRATER_CONTEXT_CHARS", "9999"],
    ["KRATER_CONTEXT_CHARS", "2000001"],
    ["KRATER_TOOL_OUTPUT_CHARS", "999"],
    ["KRATER_TOOL_OUTPUT_CHARS", "250001"],
    ["KRATER_MAX_STEPS", "0"],
    ["KRATER_MAX_STEPS", "129"],
    ["KRATER_MAX_OUTPUT_TOKENS", "255"],
    ["KRATER_MAX_OUTPUT_TOKENS", "65537"],
    ["KRATER_SESSION_TOKEN_BUDGET", "999"],
    ["KRATER_SESSION_TOKEN_BUDGET", "10000001"],
  ])("rejects invalid %s value %s", async (name, value) => {
    const cwd = await temporaryDirectory();
    expect(() => loadConfig({ cwd }, { [name]: value })).toThrow(/Invalid/);
  });

  it("rejects unknown response styles", async () => {
    const cwd = await temporaryDirectory();
    expect(() =>
      loadConfig({ cwd }, { KRATER_RESPONSE_STYLE: "verbose" }),
    ).toThrow(/response style/);
  });

  it("never treats unrelated OpenAI credentials as Krater credentials", async () => {
    const cwd = await temporaryDirectory();
    const config = loadConfig(
      { cwd },
      {
        OPENAI_API_KEY: "must-not-be-used",
        OPENAI_BASE_URL: "https://must-not-be-used.example/v1",
      },
    );
    expect(config.apiKey).toBeUndefined();
    expect(config.apiKeySource).toBe("missing");
    expect(config.baseURL).toBe(DEFAULT_BASE_URL);
  });

  it("rejects a workspace path that is a regular file", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "not-a-directory");
    await writeFile(file, "content");

    expect(() => loadConfig({ cwd: file }, {})).toThrow(/workspace.*directory/i);
  });

  it("rejects a workspace path that does not exist", async () => {
    const cwd = await temporaryDirectory();

    expect(() => loadConfig({ cwd: join(cwd, "missing") }, {})).toThrow(
      /Workspace (?:does not exist|is not a directory)/,
    );
  });
});

describe("requireApiKey", () => {
  it("returns a configured key and explains all supported configuration paths", async () => {
    const cwd = await temporaryDirectory();
    const configured = loadConfig({ cwd, apiKey: "kr_command" }, {});
    expect(requireApiKey(configured)).toBe("kr_command");

    const missing = loadConfig({ cwd }, {});
    expect(() => requireApiKey(missing)).toThrow(
      "Pass --api-key, set KRATER_API_KEY, or add it to .env.",
    );
  });
});
