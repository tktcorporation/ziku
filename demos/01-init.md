# init

Apply a template to your project from GitHub

---

$ npx ziku

> [bold][cyan] ziku [/cyan][/bold] [gray]v1.2.0[/gray]

[spinner:1200] Resolving template source...

> [gray]◇[/gray] Which template repository to use?
> [select:1500] Template: | my-org/dev-templates (upstream), my-org/infra-config (fork) | 0

> [gray]◇[/gray] Select directories to sync
> [multiselect:1800] Directories: | .claude/**, .devcontainer/**, .github/\*\* | 0,1,2

> [gray]◇[/gray] How to handle existing files?
> [select:1200] Strategy: | Overwrite all, Skip (keep existing), Ask for each file | 0

[spinner:2000] Downloading template...

> [green]+[/green] .claude/settings.json
> [green]+[/green] .devcontainer/devcontainer.json
> [green]+[/green] .devcontainer/Dockerfile
> [green]+[/green] .github/workflows/ci.yml
> [green]+[/green] .github/workflows/release.yml
> [yellow]~[/yellow] .github/dependabot.yml
> [gray]-[/gray] [gray].editorconfig[/gray]
>
> [green]5 added[/green], [yellow]1 updated[/yellow], [gray]1 skipped[/gray]

> [green]◆[/green] Template applied successfully!
