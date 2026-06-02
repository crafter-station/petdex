<div align="center">

<img src="public/brand/petdex-desktop-icon.png" alt="Petdex" width="120" />

<h1>Petdex</h1>

<p>
  The public gallery of animated companions for Codex.
  <br />
  Browse, install, and submit pets with one command.
</p>

<p>
  <a href="https://petdex.crafter.run"><strong>petdex.crafter.run</strong></a>
  &nbsp;·&nbsp;
  <a href="https://petdex.crafter.run/built-with">Built with Petdex</a>
  &nbsp;·&nbsp;
  <a href="https://discord.gg/byhubdyBTe">Discord</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/petdex">npm</a>
</p>

<p>
  <a href="https://www.npmjs.com/package/petdex"><img src="https://img.shields.io/npm/v/petdex?style=flat-square&label=cli&color=000000" alt="npm version" /></a>
  <a href="https://github.com/crafter-station/petdex/stargazers"><img src="https://img.shields.io/github/stars/crafter-station/petdex?style=flat-square&color=000000" alt="GitHub stars" /></a>
  <a href="https://github.com/crafter-station/petdex/blob/main/LICENSE"><img src="https://img.shields.io/github/license/crafter-station/petdex?style=flat-square&color=000000" alt="MIT license" /></a>
  <a href="https://github.com/crafter-station/petdex/issues"><img src="https://img.shields.io/github/issues/crafter-station/petdex?style=flat-square&color=000000" alt="GitHub issues" /></a>
</p>

</div>

---

## What is Petdex

Petdex is three things working together:

1. **A web gallery** at [petdex.crafter.run](https://petdex.crafter.run) where the community submits, reviews, and showcases animated pets in the Codex sprite format.
2. **A CLI** that installs any pet on your machine with one command and ships them straight into Codex.
3. **A desktop app** that floats a pet on your screen and reacts to your coding agent's activity in real time.

Every pet is a folder. Every folder is a Pokédex entry. Every entry is one `npx petdex install` away.

## Quick start

Follow this checklist to get a pet installed, visible in Codex, and connected to the desktop app.

1. Install a known pet:

```sh
npx petdex install boba
```

You should see `~/.codex/pets/boba/` with `pet.json` and a spritesheet.

2. Initialize Petdex Desktop and agent hooks:

```sh
npx petdex init
```

This downloads the desktop app, starts it, and wires supported agents for `/petdex`.

3. Open Codex, go to **Settings → Appearance → Pets**, choose **Boba**, and click **Select**. Use `/pet` inside Codex to wake the pet or tuck it away.

4. Verify the setup:

```sh
npx petdex doctor
```

If hooks are installed, you can also type `/petdex status` inside a supported agent.

## For users

| You want to... | Do this |
| --- | --- |
| Browse pets | Visit [petdex.crafter.run](https://petdex.crafter.run) |
| Install a pet | `npx petdex install <slug>` |
| Run the desktop floater | `npx petdex init` (downloads the `.dmg` and wires Codex/Claude Code hooks) |
| Make a pet | Use the `hatch-pet` skill inside Codex, or build one with the [Petdex creator tools](https://petdex.crafter.run/create) |
| Submit a pet | `npx petdex submit ./my-pet/` or drop it through the web submitter |
| Join the community | [Discord](https://discord.gg/byhubdyBTe) |

Full CLI reference: [`packages/petdex-cli/README.md`](./packages/petdex-cli/README.md).

## For builders

If you want to build on top of Petdex (a desktop client, a wearable, an SDK, a Discord bot, anything), you have two stable surfaces:

- **The HTTP API.** `petdex.crafter.run/api/manifest` returns every approved pet with its slug, spritesheet URL, animation states, and metadata.
- **The pet package format.** Every pet is a `pet.json` plus a `spritesheet.{webp,png}` rendered as an 8×9 grid of 192×208 frames.

19 open-source and source-available projects already build on these. See [petdex.crafter.run/built-with](https://petdex.crafter.run/built-with) for the catalog, then [submit yours via the issue template](https://github.com/crafter-station/petdex/issues/new?template=built-with.yml).

## Architecture

```text
crafter-station/petdex
├── src/
│   ├── app/[locale]/          Public site: gallery, /pets/<slug>, /collections, /built-with, /community, /create, /download, /submit, /u/<handle>, ...
│   ├── app/api/cli/           CLI endpoints: OAuth config, submit (zip → presigned R2), dedup check, register
│   ├── app/api/manifest/      Public manifest: every approved pet with its spritesheet URL
│   ├── app/api/admin/         Admin review surface for submissions, edits, collection requests
│   └── lib/db/schema.ts       Drizzle schema (Postgres)
├── packages/
│   ├── petdex-cli/            npm `petdex` (auth, list, install, submit, hooks, init)
│   ├── petdex-desktop/        Zig + WebKit floating mascot for macOS
│   └── discord-bot/           Discord.js bot for the Petdex server
├── public/built-with/         Screenshots for the community page
├── public/brand/              Logos, OS icons, Discord icon
└── drizzle/                   SQL migrations (Postgres schema history)
```

**Web stack**: Next.js 16, React 19, Tailwind, Drizzle, Postgres, Redis, Clerk, R2.<br />
**CLI**: Bun + TypeScript, ships as a single npm binary. Auth via Clerk OAuth + PKCE.<br />
**Desktop**: Zig on a fork of [`vercel-labs/zero-native`](https://github.com/vercel-labs/zero-native), HTTP sidecar in Node for agent hooks.

## Develop locally

Two paths are supported.

| Goal | Command | Setup |
| --- | --- | --- |
| Local full stack | `bun run dev:docker` | Docker or Podman, ~30s warm-up. |
| Run against real services | `bun run dev` | `.env.local` filled (maintainers only). |

```sh
git clone https://github.com/crafter-station/petdex.git
cd petdex
bun install
bun run dev:docker
```

Open [localhost:3000](http://localhost:3000). Full guide in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Pet package format

Every pet is two files:

```text
my-pet/
├── pet.json                Metadata: name, slug, tags, vibes, kind, frame size, animation states
└── spritesheet.webp        8 rows × 9 cols = 72 frames of 192×208 px each (or .png)
```

Animation states are the rows: `idle`, `wave`, `run`, `failed`, `review`, `jump`, `extra1`, `extra2`. Codex maps these to its agent activity hooks. Loop timing defaults to 1100ms at 6 frames per state.

## Contribute

- **Submit a pet:** [petdex.crafter.run/submit](https://petdex.crafter.run/submit) or `npx petdex submit <path>`.
- **List your project:** open a [Built with Petdex issue](https://github.com/crafter-station/petdex/issues/new?template=built-with.yml).
- **Fix a bug or add a feature:** read [`CONTRIBUTING.md`](./CONTRIBUTING.md), then open a PR.
- **Hang out:** [Discord](https://discord.gg/byhubdyBTe) has channels for shipping (`#wip`, `#ship-or-sink`), feedback (`#cli-feedback`), and showcases (`#showcase`).

## Pet IP and takedowns

Pets are user-submitted fan art. Petdex does not claim rights to any underlying IP. If you hold rights to a character and want a pet removed, file a [takedown request](https://github.com/crafter-station/petdex/issues/new?template=takedown.yml) and we review within 48 hours.

## License

The source code is [MIT](./LICENSE). Pet assets are owned by their submitters under whatever license they choose to declare.

---

<div align="center">

Made by <a href="https://crafter.run">Crafter Station</a>.
Lead: <a href="https://x.com/RaillyHugo">@RaillyHugo</a>.

</div>
