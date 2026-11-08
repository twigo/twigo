// Records how kubectl reads YAML: Kubernetes v1.37.0 reads a manifest with
// sigs.k8s.io/yaml v1.6.0 over go.yaml.in/yaml/v2 v2.4.4, which this module
// pins as go.mod of that tag does. It writes each text of cases.json and
// what YAMLToJSON makes of it, or its error, to read.json.
package main

import (
	"encoding/json"
	"os"

	"sigs.k8s.io/yaml"
)

func main() {
	raw, err := os.ReadFile("cases.json")
	if err != nil {
		panic(err)
	}
	var cases []string
	if err := json.Unmarshal(raw, &cases); err != nil {
		panic(err)
	}
	read := map[string]string{}
	for _, text := range cases {
		converted, err := yaml.YAMLToJSON([]byte(text))
		if err != nil {
			read[text] = "ERROR " + err.Error()
			continue
		}
		read[text] = string(converted)
	}
	out, err := os.Create("read.json")
	if err != nil {
		panic(err)
	}
	defer out.Close()
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(read); err != nil {
		panic(err)
	}
}
