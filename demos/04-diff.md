# diff

View differences between local files and the template

---

$ npx ziku diff --verbose

> [bold][cyan] ziku diff [/cyan][/bold] [gray]v1.2.0[/gray]

[spinner:1200] Comparing with template...

> [bold].claude/settings.json[/bold] [gray]—[/gray] [yellow]modified[/yellow] [green]+5[/green] [red]-2[/red]
>
> [cyan]@@ -3,6 +3,9 @@[/cyan]
> "permissions": {
> [red]- "allow": ["npm test"][/red]
> [green]+ "allow": [[/green]
> [green]+ "npm test",[/green]
> [green]+ "npm run lint",[/green]
> [green]+ "npm run build"[/green]
> [green]+ ][/green]
> }

> [bold].github/workflows/lint.yml[/bold] [gray]—[/gray] [green]added[/green] [green]+45[/green]
> [gray](new file — 45 lines)[/gray]

> [bold].devcontainer/devcontainer.json[/bold] [gray]—[/gray] [yellow]modified[/yellow] [green]+1[/green] [red]-1[/red]
>
> [cyan]@@ -8,3 +8,3 @@[/cyan]
> [red]- "postCreateCommand": "npm install"[/red]
> [green]+ "postCreateCommand": "pnpm install"[/green]

> [gray]Summary: 1 added, 2 modified, 0 deleted[/gray]
