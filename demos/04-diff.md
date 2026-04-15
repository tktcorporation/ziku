# diff

Show differences between local files and the template

---

$ npx ziku diff --verbose

> [bold][cyan]┌   ziku diff  v1.2.0[/cyan][/bold]
> [gray]│[/gray]
> [bold]●[/bold]  Template: my-org/dev-templates

[spinner:1200] Detecting changes...

[spinner:1000] Analyzing differences...

> [gray]│[/gray]
> [gray]│[/gray]  [yellow]~[/yellow] .claude/settings.json
> [gray]│[/gray]  [green]+[/green] .github/workflows/lint.yml
> [gray]│[/gray]  [yellow]~[/yellow] .devcontainer/devcontainer.json
> [gray]│[/gray]
> [gray]│[/gray]  [green]+1 added[/green] [gray]|[/gray] [yellow]~2 modified[/yellow]
> [gray]│[/gray]
> [gray]◇[/gray]  .claude/settings.json — [yellow]modified[/yellow] [green]+1[/green] [red]-0[/red]
> [gray]│[/gray]
> [gray]│[/gray]  [cyan]@@ -3,3 +3,4 @@[/cyan]
> [gray]│[/gray]     "allow": [
> [gray]│[/gray]       "npm test",
> [gray]│[/gray]       "npm run lint",
> [gray]│[/gray]  [green]+    "npm run build"[/green]
> [gray]│[/gray]     ]
> [gray]│[/gray]
> [gray]◇[/gray]  .github/workflows/lint.yml — [green]added[/green] [green]+12[/green]
> [gray]│[/gray]  [gray](new file — 12 lines)[/gray]
> [gray]│[/gray]
> [gray]◇[/gray]  .devcontainer/devcontainer.json — [yellow]modified[/yellow] [green]+2[/green] [red]-1[/red]
> [gray]│[/gray]
> [gray]│[/gray]  [cyan]@@ -4,3 +4,4 @@[/cyan]
> [gray]│[/gray]  [red]-  "postCreateCommand": "npm install",[/red]
> [gray]│[/gray]  [green]+  "postCreateCommand": "pnpm install",[/green]
> [gray]│[/gray]       "extensions": [
> [gray]│[/gray]  [red]-      "esbenp.prettier-vscode"[/red]
> [gray]│[/gray]  [green]+      "esbenp.prettier-vscode",[/green]
> [gray]│[/gray]  [green]+      "bradlc.vscode-tailwindcss"[/green]
> [gray]│[/gray]
> [gray]└[/gray]  Run [cyan]ziku push[/cyan] to push changes.
