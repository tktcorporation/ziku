# pull

Pull the latest template updates with 3-way merge

---

$ npx ziku pull

> [bold][cyan]┌   ziku pull  v1.2.0[/cyan][/bold]
> [gray]│[/gray]
> [bold]●[/bold]  Template: my-org/dev-templates

[spinner:1500] Fetching latest template...

> [gray]│[/gray]

[spinner:1800] Analyzing changes...

> [gray]│[/gray]
> [gray]│[/gray]  [green]+[/green] .github/workflows/security.yml
> [gray]│[/gray]  [green]+[/green] .claude/rules/testing.md
> [gray]│[/gray]  [yellow]~[/yellow] .devcontainer/devcontainer.json
> [gray]│[/gray]
> [gray]│[/gray]  [green]+2 added[/green] [gray]|[/gray] [yellow]~1 modified[/yellow]
> [gray]│[/gray]

[spinner:1500] Merging changes (3-way)...

> [gray]│[/gray]
> [gray]│[/gray]  [green]✓[/green] .github/workflows/security.yml [gray]— new file[/gray]
> [gray]│[/gray]  [green]✓[/green] .claude/rules/testing.md [gray]— new file[/gray]
> [gray]│[/gray]  [green]✓[/green] .devcontainer/devcontainer.json [gray]— auto-merged[/gray]
> [gray]│[/gray]
> [green]└[/green]  Pull complete — 3 files updated, 0 conflicts
