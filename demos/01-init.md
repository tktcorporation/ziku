# init

Apply a template to your project

---

$ npx ziku init --from my-org/dev-templates

> [bold][cyan]┌   ziku  v1.2.0[/cyan][/bold]
> [gray]│[/gray]
> [bold]●[/bold]  Target: /home/user/my-project
> [gray]│[/gray]
> [bold]●[/bold]  Template: my-org/dev-templates

[spinner:1500] Resolving template...

> [gray]│[/gray]

[multiselect:2500] Select directories to apply: | .claude/**, .devcontainer/**, .github/**, .mcp.json | 0,1,2,3

> [gray]│[/gray]

[select:1500] How to handle existing files? | Overwrite all, Skip existing, Ask for each | 0

> [gray]│[/gray]

[spinner:2000] Applying templates...

> [gray]│[/gray]
> [gray]│[/gray]  [green]+[/green] .claude/rules/code-style.md
> [gray]│[/gray]  [green]+[/green] .claude/settings.json
> [gray]│[/gray]  [green]+[/green] .devcontainer/devcontainer.json
> [gray]│[/gray]  [green]+[/green] .github/dependabot.yml
> [gray]│[/gray]  [green]+[/green] .github/workflows/ci.yml
> [gray]│[/gray]  [green]+[/green] .ziku/ziku.jsonc
> [gray]│[/gray]  [green]+[/green] .ziku/lock.json
> [gray]│[/gray]
> [gray]│[/gray]  [green]7 added[/green]
> [gray]│[/gray]
> [green]└[/green]  Setup complete!
>
> Next steps:
>   [cyan]git add . && git commit -m 'chore: add ziku config'[/cyan]
>   Commit the changes
>   [cyan]npx ziku diff[/cyan]
>   Check for updates from upstream
