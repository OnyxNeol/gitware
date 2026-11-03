# Gitware for Gitea

The web version of Gitware: the same repository that holds your `.gitgram`
sources and a `gitware pages build` output also gets a **Hardware** tab in
Gitea, showing the PCB, the schematic, net highlighting and the design summary.

It is built the way Gitea expects extensions to be built, so the instance stays
upgradeable:

| Piece | Gitea mechanism |
| --- | --- |
| Hardware tab in the repo header | `custom/templates/custom/extra_tabs.tmpl` |
| Diff badges on commits and PRs | `custom/templates/custom/body_outer_post.tmpl` |
| Viewer page and modules | `custom/public/assets/gitware/**`, served at `<subUrl>/assets/gitware/` |
| Colours, fonts, dark mode | Gitea's own stylesheet (`/assets/css/index.css`) and its CSS variables |
| File access | Gitea's raw route `/<owner>/<repo>/raw/branch/<ref>/<path>`, so private repositories work with the session the browser already has |
| Project discovery | Gitea's tree API, with a fallback to fixed build locations |

Nothing is re-rendered in the browser that `gitware pages build` already
produced, so the repository remains the single source of truth.

## Install (no fork)

```sh
GITEA_CUSTOM=/var/lib/gitea/custom ./install.sh
```

Then restart Gitea. The tab appears on every repository; a repository without a
build shows the exact command that produces one.

`install.sh` copies `custom/templates` and `custom/public/assets` only, so it
never overwrites unrelated customisations.

## Where the build lives

The viewer looks for a manifest in this order, and takes the first one that
parses:

1. `dist/pages/manifest.json`
2. `dist/manifest.json`
3. `pages/manifest.json`
4. `gitware/manifest.json`
5. `manifest.json`
6. `gitware.json`
7. any other `*/manifest.json`, with the Pages layout (`p/<slug>/manifest.json`)
   ahead of unrelated directories

A repository holding several hardware projects therefore still opens the
obvious one, and `gitware pages build --out dist` is all a single-board project
needs to commit.

## Storage

`demo/` is a working Gitea 1.22.6 instance whose storage lives here rather than
in a temporary directory:

```
demo/app.ini            instance config (SQLite, repo root below)
demo/data/gitea.db      users, tokens, mirror settings
demo/data/repos/        the git repositories themselves
demo/custom/            this overlay, installed
demo/run.sh             start it on http://127.0.0.1:3000
```

The project content comes from the repository the agent created,
`OnyxNeol/gitware` on GitHub, pulled in as a Gitea mirror (`onyx/gitware`), so
the Hardware tab runs against the real project rather than a fixture. `onyx/hw`
stays as a second example using the single-project `dist/` layout.

## Checks

```sh
npm test                                        # 10 unit tests, no network
GITEA_BASE=http://127.0.0.1:3000 node test/live-viewer.mjs onyx gitware main
```

The live check drives the same modules the browser loads and asserts the Gitea
routes, the theme stylesheet, the tree API, manifest discovery and the byte
sizes of every rendered file.

## If you fork Gitea instead

The overlay needs no Go changes. A fork only buys a native route and server-side
rendering; the equivalent of the tab plus page is:

- `routers/web/web.go`: in the repo group,
  `m.Get("/gitware", repo.MustBeNotEmpty, reqRepoCodeReader, repo.Gitware)`.
- `routers/web/repo/gitware.go`: resolve the manifest server-side with the
  existing `ctx.Repo.GitRepo` and render `repo/gitware` with `ctx.HTML`.
- `templates/repo/gitware.tmpl`: extend `repo/base`, which is what gives the
  page Gitea's header, breadcrumbs and sidebar for free.
- `routers/web/base.go`: add `tplRepoGitware base.TplName = "repo/gitware"`.

Server-side rendering removes the extra raw-file requests but not their logic:
the manifest and the built artefacts are still the source of truth.
