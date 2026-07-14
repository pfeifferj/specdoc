{{/* Common metadata labels. Selector labels stay the legacy {app, component}
pair inline in each template because Deployment selectors are immutable and
must match the resources this chart adopts. */}}
{{- define "specdoc.labels" -}}
app: hedgedoc
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "specdoc.image" -}}
{{ .registry }}/{{ .image.repository }}:{{ .image.tag }}
{{- end -}}
