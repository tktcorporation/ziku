# push

Push local improvements back to the template via PR

---

$ npx ziku push

> [bold][cyan] ziku push [/cyan][/bold] [gray]v1.2.0[/gray]
> [gray]Non-interactive: ziku push --yes --files <paths> -m <title>[/gray]

[spinner:1500] Comparing local files with template...

> [yellow]~[/yellow] .claude/settings.json [green]+12[/green] [red]-3[/red]
> [green]+[/green] .github/workflows/lint.yml [green]+45[/green]
> [yellow]~[/yellow] .devcontainer/devcontainer.json [green]+2[/green] [red]-1[/red]
>
> [green]+1 added[/green] [gray]|[/gray] [yellow]~2 modified[/yellow]

> [gray]◇[/gray] Select files to include in PR
> [multiselect:2000] Files: | .claude/settings.json (+12 -3), .github/workflows/lint.yml (+45), .devcontainer/devcontainer.json (+2 -1) | 0,1,2

> [gray]◇[/gray] PR title
> [cyan]feat: add lint workflow and update configs[/cyan]

[spinner:2000] Creating pull request...

> [green]◆[/green] PR created: [cyan]https://github.com/my-org/dev-templates/pull/42[/cyan]
