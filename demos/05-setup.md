# setup

Initialize a template repository with ziku

---

$ npx ziku setup

> [bold][cyan] ziku setup [/cyan][/bold] [gray]v1.2.0[/gray]

[spinner:800] Scanning directory...

> [gray]ℹ[/gray] Found config files:
> .claude/settings.json
> .devcontainer/devcontainer.json
> .github/workflows/ci.yml
> .github/dependabot.yml

> [gray]◇[/gray] Select patterns to include in template
> [multiselect:1800] Patterns: | .claude/**, .devcontainer/**, .github/\*\* | 0,1,2

[spinner:1000] Writing .ziku/ziku.jsonc...

> [green]◆[/green] Template repository initialized!
>
> [gray]Created: .ziku/ziku.jsonc[/gray]
> [gray]Include: .claude/**, .devcontainer/**, .github/\*\*[/gray]
>
> [gray]Next: commit and push, then run[/gray] [cyan]npx ziku --from owner/repo[/cyan] [gray]in your projects[/gray]
