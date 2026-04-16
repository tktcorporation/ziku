# diff

Show differences between local files and the template

---

$ npx ziku diff --verbose

> ┌ [bold][cyan]ziku diff[/cyan][/bold] [gray]v1.2.0[/gray]
> │
> ● Template: my-org/dev-templates

[spinner:1200] Detecting changes...

[spinner:1000] Analyzing differences...

> │
> │ [red]-[/red] .claude/rules/testing.md
> │ [yellow]~[/yellow] .devcontainer/devcontainer.json
> │ [red]-[/red] .github/workflows/lint.yml
> │ [red]-[/red] .github/workflows/security.yml
> │
> │ [yellow]~1 modified[/yellow] | [red]-3 deleted[/red]
> │
> [gray]◇[/gray] .claude/rules/testing.md — [red]deleted[/red] [red]-5[/red]
> │
> [gray]◇[/gray] .devcontainer/devcontainer.json — [yellow]modified[/yellow] [green]+3[/green] [red]-2[/red]
> │
> │ [cyan]@@ -1,13 +1,14 @@[/cyan]
> │ {
> │ "name": "Node.js Dev",
> │ "image": "mcr.microsoft.com/devcontainers/typescript-node:20",
> │ [red]- "postCreateCommand": "npm install",[/red]
> │ [green]+ "postCreateCommand": "pnpm install",[/green]
> │ "customizations": {
> │ "vscode": {
> │ "extensions": [
> │ "dbaeumer.vscode-eslint",
> │ [red]- "esbenp.prettier-vscode"[/red]
> │ [green]+ "esbenp.prettier-vscode",[/green]
> │ [green]+ "bradlc.vscode-tailwindcss"[/green]
> │ ]
> │ }
> │ }
> │ }
> │
> │
> [gray]◇[/gray] .github/workflows/lint.yml — [red]deleted[/red] [red]-12[/red]
> │
> [gray]◇[/gray] .github/workflows/security.yml — [red]deleted[/red] [red]-12[/red]
> │
> └ Run [cyan]ziku push[/cyan] to push changes.
