# push

Push local improvements back to the template

---

$ npx ziku push

> ┌ [bold][cyan]ziku push[/cyan][/bold] [gray]v1.2.0[/gray]
> │

[spinner:1200] Detecting changes...

> │

[spinner:1000] Analyzing differences...

[spinner:800] Selecting files...

[multiselect:3000] Select files to include in PR | ~ .claude/settings.json (+2 -1), + .devcontainer/devcontainer.env.example (+13), + .github/workflows/lint.yml (+12) | 0,1,2

> │
> │ To /home/user/dev-templates [gray](local)[/gray]
> │ ──────────────────────────────────────────────────────
> │ [yellow]~[/yellow] .claude/settings.json [green]+2[/green] [red]-1[/red]
> │ [green]+[/green] .devcontainer/devcontainer.env.example [green]+13[/green]
> │ [green]+[/green] .github/workflows/lint.yml [green]+12[/green]
> │ ──────────────────────────────────────────────────────
> │ Push: push 3 file(s)
> │

[select:1500] Push to local template? | Yes, No | 0

> │

[spinner:1500] Pushing to local template...

> │
> │ [green]+[/green] .claude/settings.json
> │
> │ [green]+[/green] .devcontainer/devcontainer.env.example
> │
> │ [green]+[/green] .github/workflows/lint.yml
> │
> [green]◆[/green] Pushed 3 file(s) to /home/user/dev-templates
> │
> └ Push complete
