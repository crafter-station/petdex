export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let dollarTag: string | null = null;
  // `--` runs to end of line; `/* */` nests in Postgres. Both are comments
  // wherever they appear outside a string, and the `--> statement-breakpoint`
  // marker drizzle writes is itself a `--` line comment — so a splitter that
  // treats `--` as ordinary text splits on the first `;` inside a comment and
  // glues the following statement onto the comment body. Comments are kept in
  // the output; only the statement boundaries care about them.
  let inLineComment = false;
  let blockDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inLineComment) {
      current += character;
      if (character === "\n") inLineComment = false;
      continue;
    }

    if (blockDepth > 0) {
      current += character;
      if (character === "*" && source[index + 1] === "/") {
        current += source[index + 1];
        index += 1;
        blockDepth -= 1;
      } else if (character === "/" && source[index + 1] === "*") {
        current += source[index + 1];
        index += 1;
        blockDepth += 1;
      }
      continue;
    }

    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += character;
      }
      continue;
    }

    if (quote === "single") {
      current += character;
      if (character === "'" && source[index + 1] === "'") {
        current += source[index + 1];
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === "double") {
      current += character;
      if (character === '"' && source[index + 1] === '"') {
        current += source[index + 1];
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }

    if (character === "-" && source[index + 1] === "-") {
      current += "--";
      index += 1;
      inLineComment = true;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      current += "/*";
      index += 1;
      blockDepth = 1;
      continue;
    }
    if (character === "'") {
      quote = "single";
      current += character;
      continue;
    }
    if (character === '"') {
      quote = "double";
      current += character;
      continue;
    }
    if (character === "$") {
      const match = source
        .slice(index)
        .match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (character === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }
    current += character;
  }

  const statement = current.trim();
  if (statement) statements.push(statement);
  return statements;
}
