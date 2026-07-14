# specdoc chart

deploys the whole specdoc stack as one helm release: the editor (the
`adfinis/hedgedoc` chart as a subchart), postgres, a nightly pg_dump
CronJob, and the spec board.

## layout

- `postgres`: sclorg postgres (random-UID safe), hostPath PV, `Notes` store
- `backup`: nightly `pg_dump`, own hostPath PV, verify-then-publish, retention
- `specBoard`: the board Deployment/Service/Ingress
- `hedgedoc`: the adfinis subchart; `hedgedoc.enabled=false` to point the
  stack at a hedgedoc deployed elsewhere

resource names are fixed (`hedgedoc-postgres`, `spec-board`,
`hedgedoc-pgdump`, the PVs/PVCs) so the board's `PGHOST` and the editor's
`externalDatabase.host` resolve, and an existing raw-manifest deployment can
be adopted in place.

## install

```sh
helm dependency build deploy/chart
helm upgrade --install hedgedoc deploy/chart -n hedgedoc -f your-values.yaml
```

## prerequisites

- secret `hedgedoc-secrets` created out-of-band (keys documented in
  `values.yaml`); the chart doesn't manage secrets.
- the postgres and backup hostPath dirs chowned `root:0` + chmod `2770`
  before first start.
