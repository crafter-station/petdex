# ChatGPT pet integration (`codex://pets/install`)

Everything here was read out of ChatGPT.app's own bundle on 2026-07-27, against
version **26.721.31836**. None of it is a documented contract. When OpenAI ships
an update, re-derive it with the recipe at the bottom rather than trusting this
file: the point of writing it down is that the next pass starts from a known
shape, not from zero.

## Status: correct link, feature gated off

The link Petdex builds satisfies every rule the app's parser enforces. It still
does nothing, because the modal that consumes it sits behind a Statsig gate that
is currently off. Verified by firing a real link at a real install: ChatGPT
takes focus, no modal appears, nothing is written to disk.

So: nothing to fix on our side, and nothing that will work until the flag flips.
Keep the `petdex://` path beside it — that one works on all three platforms.

## The contract

```
codex://pets/install?name=…&description=…&imageUrl=…&spriteVersionNumber=…
```

| Rule | Detail |
|---|---|
| Schemes | `codex://` and `codex-dev://` |
| Host | must be `pets` |
| Path | exactly one segment, `install` |
| Params | `name`, `description`, `imageUrl`, `spriteVersionNumber` |
| Extra params | **one unknown param rejects the whole URL** |
| `name` | required, trimmed, non-empty |
| `description` | optional |
| `imageUrl` | required, must parse as a URL with protocol `https:` |
| `spriteVersionNumber` | must coerce to `1` or `2`; defaults to `1` |

`spriteVersionNumber` is the one that bit us: it has to match the atlas, and
omitting it defaults the app to layout 1, which misreads every frame of a v2
sheet. Petdex ships **both** layouts — v1 (8x9) is actually the majority of the
approved catalog (measured 2026-10-10: 4631 of 4876), v2 (8x11) the rest — so
the number must come from the pet's own `spriteVersionNumber`, never a fixed
guess. (An earlier revision of this doc said "Petdex ships v2 atlases" and the
builder hardcoded `?? 2`, which sent the wrong layout for every v1 pet.) It was
absent from the original builder because that was inferred from a JSON-LD
`InstallAction` on `chatgpt.com/s/sharepet_<id>`, which does not carry it.

### What the downloader demands

Separate from the URL parse, the asset fetch enforces:

- `redirect: "manual"`, and it **throws on any redirect status**. The URL has to
  answer 200 directly. A CDN that 301s to its origin breaks the install.
- `Content-Type` must be `image/png` or `image/webp` (the type is lowercased and
  split on `;`, so a charset suffix is fine).
- 20 MB ceiling, checked against `Content-Length` and again while streaming.

Petdex assets satisfy all three today: `assets.petdex.dev` answers 200 with
`image/webp`, largest sheet ~2.7 MB.

## Why a correct link still does nothing

The main process parses the URL, matches `case 'petInstall'`, focuses the
window, and posts `open-pet-install-modal` to the renderer. The renderer's
listener is:

```js
let t = kh(`1848317837`);
Kf(`open-pet-install-modal`, n => {
  t && Promise.all([...]).then(...)
})
```

`kh()` is the Statsig gate helper. With the gate off, `t` is falsy, the `&&`
short-circuits, and the message is dropped with no error and no log. From the
outside this is indistinguishable from the URL never arriving, which is why the
first diagnosis has to be "check the gate", not "fix the link".

`1848317837` appears exactly once in the bundle.

## Where the code lives

Paths inside `Contents/Resources/app.asar` (they carry content hashes and
**will change** on any update — grep for the symbols, not the filenames):

| What | Where | Grep for |
|---|---|---|
| URL parser | `.vite/build/window-all-closed-*.js` | `` kind:`petInstall` `` |
| Host switch | same file | `` case`pets` `` |
| Allowed params | same file | `` new Set([`name`,`description` `` |
| Deep link handler | `.vite/build/main-*.js` | `` case`petInstall` `` |
| IPC handlers | same file | `"pet-install"`, `"pet-install-preview"` |
| Install manager | same file | `petInstallManager`, class with `preview`/`install` |
| Asset validation | same file | `Pet spritesheet redirects are not allowed` |
| Renderer listener + gate | `webview/assets/app-initial-*.js` | `open-pet-install-modal` |

There is also a `pet-install-preview` IPC handler taking the same four
arguments, which returns a data URL instead of installing. Nothing reachable
from a deep link uses it — it is what the modal renders.

## How to re-derive this after an update

```bash
# 1. Extract (196MB asar, ~220MB extracted; delete it when done)
npx --yes @electron/asar extract \
  /Applications/ChatGPT.app/Contents/Resources/app.asar /tmp/asar

# 2. Is the route still there?
grep -rl "petInstall" --include="*.js" /tmp/asar

# 3. Read the parser -- this is the authority on the URL shape
python3 - <<'EOF'
import glob
p = glob.glob('/tmp/asar/.vite/build/window-all-closed-*.js')[0]
s = open(p, encoding='utf8', errors='replace').read()
i = s.index('kind:`petInstall`')
print(s[i-1600:i+400])
EOF

# 4. Did the gate id change, or the gate disappear (feature shipped)?
grep -rho "1848317837" --include="*.js" /tmp/asar | wc -l

rm -rf /tmp/asar
```

The bundle is minified but not obfuscated: identifiers are mangled, string
literals are not. Every anchor in the table above is a string literal, which is
why they survive rebuilds.

### Testing a link end to end

```bash
open "codex://pets/install?name=Boba&description=x&imageUrl=https%3A%2F%2Fassets.petdex.dev%2F…%2Fsprite.webp&spriteVersionNumber=2"
```

**Pick a pet that is not already installed.** An installed slug can succeed for
the wrong reason. The only honest check is the filesystem, not the screen:

```bash
ls ~/.codex/pets/<slug>/
find ~/Library -iname "*.webp" -newermt "-5 minutes" 2>/dev/null | grep -i openai
```

## The reverse direction already works

Petdex reads ChatGPT's pets with no conversion: same atlas, same frame counts,
measured cell by cell — 9 state rows at 8×9 for v1 pets, 11 at 8×11 for the v2
exports. `~/.codex/pets/` is a root the desktop
app scans directly, and the CLI writes both roots on install. So a pet acquired
either way shows up in both places, and `petdex://<slug>` is the path that
actually works today.
