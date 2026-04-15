# push

Push local improvements back to the template

---

$ npx ziku push

> [bold][cyan]┌   ziku push  v1.2.0[/cyan][/bold]
> [gray]│[/gray]

[spinner:1500] Comparing local files with template...

> [gray]│[/gray]
> [gray]│[/gray]  [yellow]~[/yellow] .claude/settings.json [green]+1[/green] [red]-0[/red]
> [gray]│[/gray]  [green]+[/green] .github/workflows/lint.yml [green]+12[/green]
> [gray]│[/gray]  [yellow]~[/yellow] .devcontainer/devcontainer.json [green]+2[/green] [red]-1[/red]
> [gray]│[/gray]
> [gray]│[/gray]  [green]+1 added[/green] [gray]|[/gray] [yellow]~2 modified[/yellow]
> [gray]│[/gray]

[multiselect:2500] Select files to push: | .claude/settings.json (+1 -0), .github/workflows/lint.yml (+12), .devcontainer/devcontainer.json (+2 -1) | 0,1,2

> [gray]│[/gray]

[spinner:1500] Pushing to template...

> [gray]│[/gray]
> [gray]│[/gray]  [green]+[/green] .claude/settings.json
> [gray]│[/gray]  [green]+[/green] .github/workflows/lint.yml
> [gray]│[/gray]  [green]+[/green] .devcontainer/devcontainer.json
> [gray]│[/gray]
> [green]└[/green]  Push complete — 3 files updated
