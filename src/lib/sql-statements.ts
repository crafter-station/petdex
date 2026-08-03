export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let dollarTag: string | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

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
