# pull

Pull the latest template updates with 3-way merge

---

$ npx ziku pull

> [bold][cyan] ziku pull [/cyan][/bold] [gray]v1.2.0[/gray]

[spinner:1500] Fetching latest template...

> [gray]ℹ[/gray] Template updated: [cyan]abc1234[/cyan] → [cyan]def5678[/cyan]

> [green]+[/green] [green].github/workflows/security.yml[/green]
> [yellow]~[/yellow] [yellow].devcontainer/devcontainer.json[/yellow]
> [yellow]~[/yellow] [yellow].claude/settings.json[/yellow]
>
> [green]+1 added[/green] [gray]|[/gray] [yellow]~2 modified[/yellow]

[spinner:1800] Merging changes (3-way)...

> [green]✓[/green] .github/workflows/security.yml [gray]— new file[/gray]
> [green]✓[/green] .devcontainer/devcontainer.json [gray]— auto-merged[/gray]
> [green]✓[/green] .claude/settings.json [gray]— auto-merged[/gray]

> [green]◆[/green] Pull complete — 3 files updated, 0 conflicts
