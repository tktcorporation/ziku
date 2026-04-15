# init

Apply a template to your project

---

$ npx ziku init --from my-org/dev-templates

> ┌   [bold][cyan]ziku[/cyan][/bold]  [gray]v1.2.0[/gray]
> │
> ●  Target: /home/user/my-project
> │
> ●  Template: my-org/dev-templates

[spinner:1200] Selecting directories...

[multiselect:2500] Select directories to sync | .claude (.claude/settings.json .claude/rules/*.md ...), .devcontainer (.devcontainer/**), .github (.github/**), Root files (.mcp.json) | 0,1,2,3

> │

[select:1500] How to handle existing files? | Overwrite all, Skip (keep existing), Ask for each file | 0

> │

[spinner:2000] Applying templates...

> │
> │  [green]+[/green] .claude/rules/code-style.md
> │  [green]+[/green] .claude/rules/testing.md
> │  [green]+[/green] .claude/settings.json
> │  [green]+[/green] .devcontainer/devcontainer.env.example
> │  [green]+[/green] .devcontainer/devcontainer.json
> │  [green]+[/green] .github/dependabot.yml
> │  [green]+[/green] .github/workflows/ci.yml
> │  [green]+[/green] .github/workflows/lint.yml
> │  [green]+[/green] .github/workflows/security.yml
> │  [yellow]~[/yellow] .devcontainer/devcontainer.env.example
> │  [green]+[/green] .ziku/ziku.jsonc
> │  [green]+[/green] .ziku/lock.json
> │
> │  [green]11 added[/green], [yellow]1 updated[/yellow]
> │
> └  Setup complete!
>
> Next steps:
>   [cyan]git add . && git commit -m 'chore: add ziku config'[/cyan]
>   Commit the changes
>   [cyan]npx ziku diff[/cyan]
>   Check for updates from upstream
