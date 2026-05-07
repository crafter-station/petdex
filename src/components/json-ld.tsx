// Inline JSON-LD as a server component. We render a real <script> tag with
// type="application/ld+json" so Google indexes the static HTML, no JS
// execution needed.
//
// Security: the JSON can contain user-controlled strings (pet displayName,
// description, tags). A naive JSON.stringify lets a value like
// `Boba</script><script>alert(1)</script>` close the script tag early and
// inject HTML. We escape the closing-script and HTML-comment sequences plus
// U+2028 / U+2029 (line terminators in legacy parsers).

type Props = {
  data: Record<string, unknown> | Record<string, unknown>[];
};

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function escapeJsonForScriptTag(json: string): string {
  let out = json
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/<!--/g, "<\\!--");
  out = out.split(LS).join("\\u2028").split(PS).join("\\u2029");
  return out;
}

export function JsonLd({ data }: Props) {
  const safe = escapeJsonForScriptTag(JSON.stringify(data));
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON escaped above
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
