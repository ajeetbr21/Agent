/**
 * A last line of defence for full access mode, where the model's shell commands run without
 * approval. It does NOT try to judge every command — ordinary builds, tests, installs, git commits
 * and deleting build folders pass straight through. It only flags commands that can destroy data
 * outside the project, wipe uncommitted work, or run code downloaded from the internet, so the user
 * is asked first. Pure (no vscode import) so it is unit-testable.
 *
 * The line is split into simple commands first (on ; && || | and newlines), so one flagged part of
 * a chain doesn't mislabel the rest, and every operand of a delete is checked — not just the first.
 */

/** Recursive-delete commands, by the flags that make them recursive/forced. */
const DELETE_COMMANDS = new Set(["rm", "rmdir", "rd", "del", "erase", "remove-item", "ri"]);

/** Targets that mean "much more than a project folder". */
function isBroadTarget(operand: string): boolean {
  const value = stripQuotes(operand);
  if (!value) {
    return false;
  }
  const unix = value.replace(/\\/g, "/");
  // Everything here, the parent, a drive root, the home directory, or a glob over any of them.
  return (
    /^\*+$/.test(unix) ||
    /^\.\/?\*+$/.test(unix) ||
    /^\.\.(\/.*)?$/.test(unix) ||
    unix === "/" ||
    /^\/\*+$/.test(unix) ||
    /^[a-z]:(\/\*?)?$/i.test(unix) ||
    /^~(\/.*)?$/.test(unix) ||
    /^\$(\{)?HOME(\})?(\/.*)?$/.test(value) ||
    /^%USERPROFILE%(\\.*|\/.*)?$/i.test(value) ||
    /^\$env:USERPROFILE(\/.*)?$/i.test(value) ||
    // An absolute path outside any project: /home, /Users, /etc, /var …
    /^\/(home|users|etc|var|usr|bin|sbin|lib|opt|boot|dev|proc|sys|root)(\/|$)/i.test(unix)
  );
}

/** .git holds the repository's history and its hook/filter configuration. */
function isRepositoryInternals(operand: string): boolean {
  const unix = stripQuotes(operand).replace(/\\/g, "/").replace(/\/+$/, "");
  return unix === ".git" || unix.endsWith("/.git");
}

interface SimpleCommand {
  /** Command name, lowercased and without a path or .exe suffix. */
  readonly name: string;
  /** Raw tokens after the command name. */
  readonly args: readonly string[];
  /** The whole simple command, for rules that need the raw text. */
  readonly text: string;
  /** True when this command reads a pipe whose producer downloads from the network. */
  readonly pipedFromDownload?: boolean;
}

/** Rules matched against ONE simple command (not the whole chain). */
const RULES: readonly { readonly test: (command: SimpleCommand) => boolean; readonly reason: string }[] = [
  {
    reason: "recursively deletes a drive, home directory, parent folder or everything in the current folder",
    test: (command) =>
      DELETE_COMMANDS.has(command.name) &&
      hasRecursiveDeleteFlag(command) &&
      operandsOf(command).some(isBroadTarget)
  },
  {
    reason: "deletes the repository's .git directory (its history and configuration)",
    test: (command) => DELETE_COMMANDS.has(command.name) && operandsOf(command).some(isRepositoryInternals)
  },
  {
    reason: "formats a drive",
    test: (command) => (command.name === "format" || command.name === "format.com") && /^[a-z]:/i.test(command.args[0] ?? "")
  },
  {
    reason: "partitions or formats disks",
    test: (command) => ["mkfs", "diskpart", "fdisk", "parted", "wipefs"].some((name) => command.name === name || command.name.startsWith("mkfs."))
  },
  {
    reason: "writes raw data to a disk device",
    test: (command) =>
      command.name === "dd" &&
      command.args.some((arg) => /^of=\/dev\//i.test(arg) && !/^of=\/dev\/(null|zero|stdout|stderr|tty)$/i.test(arg))
  },
  {
    reason: "overwrites a disk device",
    test: (command) => /> *\/dev\/(sd|nvme|hd|disk|mmcblk)/i.test(command.text)
  },
  {
    reason: "shuts down or restarts the computer",
    test: (command) => ["shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer"].includes(command.name)
  },
  {
    reason: "downloads a script from the internet and runs it immediately",
    test: (command) =>
      ["sh", "bash", "zsh", "ksh", "dash", "iex", "invoke-expression"].includes(command.name) &&
      command.pipedFromDownload === true
  },
  {
    reason: "force-pushes, which can overwrite history on the remote",
    test: (command) =>
      command.name === "git" &&
      command.args[0] === "push" &&
      (command.args.some((arg) => arg === "-f" || arg === "--force" || /^-[a-z]*f[a-z]*$/.test(arg)) ||
        command.args.some((arg) => /^\+/.test(arg) && arg.length > 1)) &&
      !command.args.some((arg) => arg.startsWith("--force-with-lease"))
  },
  {
    reason: "discards all uncommitted changes (git reset --hard)",
    test: (command) => command.name === "git" && command.args[0] === "reset" && command.args.includes("--hard")
  },
  {
    reason: "permanently deletes untracked files (git clean -f)",
    test: (command) =>
      command.name === "git" &&
      command.args[0] === "clean" &&
      command.args.some((arg) => arg === "--force" || /^-[a-z]*f/.test(arg))
  },
  {
    reason: "discards all uncommitted changes in the working tree",
    test: (command) => {
      if (command.name !== "git") {
        return false;
      }
      const [subcommand, ...rest] = command.args;
      if (subcommand !== "checkout" && subcommand !== "restore") {
        return false;
      }
      // --staged / -S only unstages; it doesn't touch the working tree.
      if (rest.some((arg) => arg === "--staged" || arg === "-S")) {
        return false;
      }
      const paths = rest.filter((arg) => arg !== "--" && !arg.startsWith("-"));
      return paths.length > 0 && paths.every((path) => path === "." || path === "./" || path === "*");
    }
  },
  {
    reason: "changes permissions or ownership of the whole filesystem",
    test: (command) =>
      (command.name === "chmod" || command.name === "chown") &&
      command.args.some((arg) => /^-[a-z]*R/i.test(arg)) &&
      operandsOf(command).slice(1).some(isBroadTarget)
  },
  {
    reason: "runs with administrator (sudo) privileges",
    test: (command) => command.name === "sudo" || command.name === "doas"
  }
];

/** Patterns judged on the whole line, because they are shell syntax rather than a command. */
const WHOLE_LINE_RULES: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /(\w*)\s*\(\s*\)\s*\{[^}]*\|\s*\1\s*&[^}]*\}\s*;\s*\1/, reason: "is a fork bomb" },
  { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, reason: "is a fork bomb" }
];

/** Why a command looks destructive, or undefined when it looks like ordinary development work. */
export function dangerousCommandReason(command: string): string | undefined {
  const wholeLine = WHOLE_LINE_RULES.find((rule) => rule.pattern.test(command));
  if (wholeLine) {
    return wholeLine.reason;
  }
  for (const simple of splitSimpleCommands(command)) {
    const rule = RULES.find((candidate) => candidate.test(simple));
    if (rule) {
      return rule.reason;
    }
  }
  return undefined;
}

/**
 * Split a command line into simple commands. Newlines count as separators (a multi-line script is
 * several commands), and a command that reads a pipe from curl/wget/Invoke-WebRequest is marked so
 * the "downloaded script" rule can see it.
 */
function splitSimpleCommands(line: string): SimpleCommand[] {
  const segments = splitTopLevel(line);
  const commands: SimpleCommand[] = [];

  for (const segment of segments) {
    const tokens = tokenize(segment.text);
    if (tokens.length === 0) {
      continue;
    }
    // Skip leading env assignments (FOO=bar cmd) and shell builtins that just wrap a command.
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
      index += 1;
    }
    if (index >= tokens.length) {
      continue;
    }
    const name = normalizeName(tokens[index]);
    const args = tokens.slice(index + 1);
    const previous = commands[commands.length - 1];
    commands.push({
      name,
      args,
      text: segment.text,
      pipedFromDownload: segment.piped && previous ? isDownloader(previous) : false
    });

    // `sudo rm -rf /` — also evaluate the wrapped command.
    if ((name === "sudo" || name === "doas") && args.length > 0) {
      let wrapped = 0;
      while (wrapped < args.length && args[wrapped].startsWith("-")) {
        wrapped += 1;
      }
      if (wrapped < args.length) {
        commands.push({ name: normalizeName(args[wrapped]), args: args.slice(wrapped + 1), text: segment.text });
      }
    }
  }
  return commands;
}

function isDownloader(command: SimpleCommand): boolean {
  return ["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod"].includes(command.name);
}

/** Split on ; && || | and newlines, ignoring separators inside quotes. */
function splitTopLevel(line: string): { text: string; piped: boolean }[] {
  const parts: { text: string; piped: boolean }[] = [];
  let current = "";
  let quote: string | undefined;
  let pipedNext = false;
  let piped = false;

  const push = () => {
    if (current.trim()) {
      parts.push({ text: current.trim(), piped });
    }
    current = "";
    piped = pipedNext;
    pipedNext = false;
  };

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\n" || char === "\r" || char === ";") {
      push();
      continue;
    }
    if (char === "|") {
      const isOr = line[index + 1] === "|";
      pipedNext = !isOr;
      push();
      if (isOr) {
        index += 1;
      }
      continue;
    }
    if (char === "&") {
      if (line[index + 1] === "&") {
        index += 1;
      }
      push();
      continue;
    }
    current += char;
  }
  push();
  return parts;
}

function tokenize(text: string): string[] {
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g);
  return tokens ?? [];
}

function normalizeName(token: string): string {
  const bare = stripQuotes(token).replace(/\\/g, "/");
  const base = bare.slice(bare.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1)$/, "");
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/**
 * Non-flag arguments (what a delete would actually remove). Windows-style switches (/s, /q) are
 * dropped, but a bare "/" or an absolute path stays — those are exactly the dangerous operands.
 */
function operandsOf(command: SimpleCommand): string[] {
  return command.args.filter((arg) => arg !== "--" && !arg.startsWith("-") && !/^\/[a-z](:.*)?$/i.test(arg));
}

/** Recursive/forced delete? Handles -rf, -r -f, --recursive, /s, -Recurse. */
function hasRecursiveDeleteFlag(command: SimpleCommand): boolean {
  if (command.name === "del" || command.name === "erase") {
    // del is only broad with /s (recurse) — a plain `del build\*.log` is fine.
    return command.args.some((arg) => /^[/-]s$/i.test(arg));
  }
  if (command.name === "rd" || command.name === "rmdir") {
    return command.args.some((arg) => /^[/-]s$/i.test(arg)) || command.args.some((arg) => /^--recursive$/i.test(arg));
  }
  if (command.name === "remove-item" || command.name === "ri") {
    return command.args.some((arg) => /^-(recurse|r)$/i.test(arg));
  }
  return command.args.some((arg) => arg === "--recursive" || /^-[a-z]*r[a-z]*$/i.test(arg));
}
