import { describe, expect, it } from "vitest";
import { classifyPreGateCommand } from "./pre-gate-command.js";

describe("pre-gate command classification", () => {
  it.each([
    ["pwd", "pwd", []],
    ["ls -la src", "ls", ["-la", "src"]],
    ["find . -maxdepth 2 -type f", "find", [".", "-maxdepth", "2", "-type", "f"]],
    ["grep -n 'Action Gate' src/agent.ts", "grep", ["-n", "Action Gate", "src/agent.ts"]],
    ['head -n 20 "README file.md"', "head", ["-n", "20", "README file.md"]],
    ["grep 'a|b' src/example.ts", "grep", ["a|b", "src/example.ts"]],
  ])(
    "allows one literal discovery executable: %s",
    (input, expectedCommand, expectedArguments) => {
      expect(classifyPreGateCommand(input)).toMatchObject({
        effect: "allow",
        code: "read_only_discovery",
        command: expectedCommand,
        arguments: expectedArguments,
      });
    },
  );

  it.each([
    "printf pre-gate > pre_gate.txt",
    "echo appended >> pre_gate.txt",
    "cat < input.txt",
    "cat <<EOF",
    "cat <<< payload",
    "cat file.txt | tee copy.txt",
    "touch pre_gate.txt",
    "mkdir pre_gate",
    "cp source target",
    "mv source target",
    "rm target",
    "chmod 777 target",
    "ln -s source target",
    "truncate -s 0 target",
    "dd if=/dev/null of=target",
    "sed -i '' s/a/b/ target",
    "sort -o target source",
    "tee target",
    "node -e 'require(\"node:fs\").writeFileSync(\"target\", \"x\")'",
    "python -c 'open(\"target\", \"w\").write(\"x\")'",
    "sh -c 'touch target'",
    "bash -c 'touch target'",
    "zsh -c 'touch target'",
    "npm test",
    "git checkout -- target",
    "find . -delete",
    "find . -exec touch target +",
    "find . -execdir touch target +",
    "find . -fprint target",
    "find . -fprintf target '%p\\n'",
    "find . -ok touch target +",
    "ls; touch target",
    "ls && touch target",
    "ls || touch target",
    "$(touch target)",
    "`touch target`",
    'grep "$(touch target)" source',
    "cat <(touch target)",
    "FOO=bar ls",
    "ls *.ts",
    "/bin/ls",
    "ls\n touch target",
  ])("rejects mutation-capable or ambiguous input: %s", (input) => {
    expect(classifyPreGateCommand(input).effect).toBe("deny");
  });

  it("does not mistake quoted control characters for shell syntax", () => {
    expect(classifyPreGateCommand("grep '; > $HOME *' source.txt")).toMatchObject({
      effect: "allow",
      command: "grep",
      arguments: ["; > $HOME *", "source.txt"],
    });
  });

  it("rejects malformed quoting and escapes", () => {
    expect(classifyPreGateCommand("grep 'unterminated")).toMatchObject({
      effect: "deny",
      code: "shell_syntax",
    });
    expect(classifyPreGateCommand("grep trailing\\")).toMatchObject({
      effect: "deny",
      code: "shell_syntax",
    });
  });
});
