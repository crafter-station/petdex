import { Fragment } from "react";

type StaticCommandLineProps = {
  command: string;
  prefix?: string;
  className?: string;
  wrap?: boolean;
};

function tokenize(command: string) {
  const parts = command.split(/(\s+|\||&&|\|\||;)/g).filter((s) => s !== "");
  let cmdSeen = false;
  let firstWordSeen = false;
  let offset = 0;

  return parts.map((p) => {
    const key = `${offset}:${p}`;
    offset += p.length;
    if (/^\s+$/.test(p)) {
      return <Fragment key={key}>{p}</Fragment>;
    }
    if (p === "|" || p === "&&" || p === "||" || p === ";") {
      return (
        <span key={key} className="text-muted-4">
          {p}
        </span>
      );
    }
    if (!firstWordSeen) {
      firstWordSeen = true;
      cmdSeen = true;
      return (
        <span key={key} className="font-medium text-brand-deep">
          {p}
        </span>
      );
    }
    if (p.startsWith("-")) {
      return (
        <span key={key} className="text-brand">
          {p}
        </span>
      );
    }
    if (cmdSeen && /^[a-z][a-z0-9-]*$/.test(p)) {
      cmdSeen = false;
      return (
        <span key={key} className="font-medium text-foreground">
          {p}
        </span>
      );
    }
    return (
      <span key={key} className="text-muted-2">
        {p}
      </span>
    );
  });
}

export function StaticCommandLine({
  command,
  prefix = "$ ",
  className = "",
  wrap = false,
}: StaticCommandLineProps) {
  const rootLayoutClass = wrap ? "items-start" : "items-center";
  const commandClass = wrap
    ? "flex-1 whitespace-normal break-words leading-5"
    : "flex-1 truncate";

  return (
    <div
      style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}
      className={`inline-flex ${rootLayoutClass} gap-2 rounded-xl border border-border-base bg-surface/80 px-3 py-2 text-left text-[12px] text-foreground backdrop-blur ${className}`}
    >
      <span className="select-none text-brand">{prefix}</span>
      <span className={commandClass}>{tokenize(command)}</span>
    </div>
  );
}
