export const BENCHMARK_TASK_COUNT = 100;
export const BENCHMARK_CATEGORY_COUNT = 10;
export const TASKS_PER_CATEGORY = 10;

export interface BenchmarkCategory {
  id: string;
  title: string;
  description: string;
}

export interface BenchmarkTaskSetup {
  summary: string;
  stack: string[];
  seedFiles: string[];
}

export interface BenchmarkTask {
  id: string;
  title: string;
  category: string;
  difficulty: "expert";
  estimatedMinutes: number;
  prompt: string;
  requiredCapabilities: string[];
  setup: BenchmarkTaskSetup;
  acceptanceCriteria: string[];
  hiddenChecks: string[];
  hazards: string[];
}

export interface BenchmarkCatalog {
  name: string;
  version: string;
  description: string;
  categories: BenchmarkCategory[];
  tasks: BenchmarkTask[];
}

export class CatalogValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(
      `Benchmark catalog validation failed with ${issues.length} issue${
        issues.length === 1 ? "" : "s"
      }:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "CatalogValidationError";
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  issues: string[],
): UnknownRecord | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }

  const allowed = new Set(requiredKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not an allowed field`);
  }
  for (const key of requiredKeys) {
    if (!(key in value)) issues.push(`${path}.${key} is required`);
  }
  return value;
}

function inspectString(
  value: unknown,
  path: string,
  issues: string[],
  minimumLength = 1,
): string | undefined {
  if (typeof value !== "string") {
    issues.push(`${path} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < minimumLength) {
    issues.push(`${path} must contain at least ${minimumLength} non-whitespace characters`);
    return undefined;
  }
  return trimmed;
}

function inspectStringArray(
  value: unknown,
  path: string,
  issues: string[],
  options: { minimumItems: number; minimumItemLength?: number },
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return undefined;
  }
  if (value.length < options.minimumItems) {
    issues.push(`${path} must contain at least ${options.minimumItems} items`);
  }

  const inspected: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const checked = inspectString(
      item,
      `${path}[${index}]`,
      issues,
      options.minimumItemLength ?? 3,
    );
    if (checked === undefined) return;
    const normalized = checked.toLocaleLowerCase();
    if (seen.has(normalized)) issues.push(`${path}[${index}] duplicates another item`);
    seen.add(normalized);
    inspected.push(checked);
  });
  return inspected;
}

function isSafeRelativeSeedPath(value: string): boolean {
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-z]:[\\/]/i.test(value) ||
    value.includes("\0")
  ) {
    return false;
  }
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function expectedTaskId(index: number): string {
  return `KC-${String(index + 1).padStart(3, "0")}`;
}

/**
 * Strictly validates unknown JSON and returns the same value with a trusted type.
 *
 * The validator deliberately aggregates issues so a generated 100-task catalog can
 * be repaired in one pass. It does not silently coerce values or discard fields.
 */
export function validateBenchmarkCatalog(value: unknown): BenchmarkCatalog {
  const issues: string[] = [];
  const catalog = inspectObject(
    value,
    "catalog",
    ["name", "version", "description", "categories", "tasks"],
    issues,
  );
  if (!catalog) throw new CatalogValidationError(issues);

  inspectString(catalog.name, "catalog.name", issues, 8);
  const version = inspectString(catalog.version, "catalog.version", issues);
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    issues.push("catalog.version must be a semantic version such as 1.0.0");
  }
  inspectString(catalog.description, "catalog.description", issues, 40);

  const categories = catalog.categories;
  const categoryIds = new Set<string>();
  if (!Array.isArray(categories)) {
    issues.push("catalog.categories must be an array");
  } else {
    if (categories.length !== BENCHMARK_CATEGORY_COUNT) {
      issues.push(
        `catalog.categories must contain exactly ${BENCHMARK_CATEGORY_COUNT} categories`,
      );
    }
    categories.forEach((candidate, index) => {
      const path = `catalog.categories[${index}]`;
      const category = inspectObject(
        candidate,
        path,
        ["id", "title", "description"],
        issues,
      );
      if (!category) return;
      const id = inspectString(category.id, `${path}.id`, issues, 3);
      if (id) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
          issues.push(`${path}.id must be a lowercase kebab-case identifier`);
        }
        if (categoryIds.has(id)) issues.push(`${path}.id must be unique`);
        categoryIds.add(id);
      }
      inspectString(category.title, `${path}.title`, issues, 5);
      inspectString(category.description, `${path}.description`, issues, 20);
    });
  }

  const tasks = catalog.tasks;
  const taskIds = new Set<string>();
  const taskTitles = new Set<string>();
  const categoryCounts = new Map<string, number>();
  if (!Array.isArray(tasks)) {
    issues.push("catalog.tasks must be an array");
  } else {
    if (tasks.length !== BENCHMARK_TASK_COUNT) {
      issues.push(`catalog.tasks must contain exactly ${BENCHMARK_TASK_COUNT} tasks`);
    }

    tasks.forEach((candidate, index) => {
      const path = `catalog.tasks[${index}]`;
      const task = inspectObject(
        candidate,
        path,
        [
          "id",
          "title",
          "category",
          "difficulty",
          "estimatedMinutes",
          "prompt",
          "requiredCapabilities",
          "setup",
          "acceptanceCriteria",
          "hiddenChecks",
          "hazards",
        ],
        issues,
      );
      if (!task) return;

      const id = inspectString(task.id, `${path}.id`, issues, 6);
      if (id) {
        const expected = expectedTaskId(index);
        if (id !== expected) {
          issues.push(`${path}.id must be ${expected} so IDs remain sequential`);
        }
        if (taskIds.has(id)) issues.push(`${path}.id must be unique`);
        taskIds.add(id);
      }

      const title = inspectString(task.title, `${path}.title`, issues, 8);
      if (title) {
        const normalized = title.toLocaleLowerCase();
        if (taskTitles.has(normalized)) issues.push(`${path}.title must be unique`);
        taskTitles.add(normalized);
      }

      const category = inspectString(task.category, `${path}.category`, issues, 3);
      if (category) {
        if (!categoryIds.has(category)) {
          issues.push(`${path}.category must reference a declared category`);
        }
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }

      if (task.difficulty !== "expert") {
        issues.push(`${path}.difficulty must be exactly "expert"`);
      }
      if (
        typeof task.estimatedMinutes !== "number" ||
        !Number.isInteger(task.estimatedMinutes) ||
        task.estimatedMinutes < 1 ||
        task.estimatedMinutes > 1_440
      ) {
        issues.push(`${path}.estimatedMinutes must be an integer from 1 to 1440`);
      }

      inspectString(task.prompt, `${path}.prompt`, issues, 80);
      inspectStringArray(task.requiredCapabilities, `${path}.requiredCapabilities`, issues, {
        minimumItems: 2,
        minimumItemLength: 3,
      });

      const setup = inspectObject(
        task.setup,
        `${path}.setup`,
        ["summary", "stack", "seedFiles"],
        issues,
      );
      if (setup) {
        inspectString(setup.summary, `${path}.setup.summary`, issues, 20);
        inspectStringArray(setup.stack, `${path}.setup.stack`, issues, {
          minimumItems: 1,
          minimumItemLength: 2,
        });
        const seedFiles = inspectStringArray(
          setup.seedFiles,
          `${path}.setup.seedFiles`,
          issues,
          { minimumItems: 1, minimumItemLength: 1 },
        );
        seedFiles?.forEach((seedFile, seedIndex) => {
          if (!isSafeRelativeSeedPath(seedFile)) {
            issues.push(
              `${path}.setup.seedFiles[${seedIndex}] must be a safe relative path`,
            );
          }
        });
      }

      inspectStringArray(task.acceptanceCriteria, `${path}.acceptanceCriteria`, issues, {
        minimumItems: 3,
        minimumItemLength: 10,
      });
      inspectStringArray(task.hiddenChecks, `${path}.hiddenChecks`, issues, {
        minimumItems: 2,
        minimumItemLength: 10,
      });
      inspectStringArray(task.hazards, `${path}.hazards`, issues, {
        minimumItems: 1,
        minimumItemLength: 10,
      });
    });
  }

  for (const categoryId of categoryIds) {
    const count = categoryCounts.get(categoryId) ?? 0;
    if (count !== TASKS_PER_CATEGORY) {
      issues.push(
        `category "${categoryId}" must contain exactly ${TASKS_PER_CATEGORY} tasks (found ${count})`,
      );
    }
  }

  if (issues.length) throw new CatalogValidationError(issues);
  return value as BenchmarkCatalog;
}
