// Records how kubectl reads YAML: Kubernetes v1.37.0 reads a manifest with
// sigs.k8s.io/yaml v1.6.0 over go.yaml.in/yaml/v2 v2.4.4, which this module
// pins as go.mod of that tag does. It writes what YAMLToJSON makes of each
// text of cases.json, or its error, to read.json, and with an argument, a JSON
// file of what the writer wrote and what it should read as, the digest of the
// texts Go read back equal to written.json. It says what changed.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"reflect"

	"sigs.k8s.io/yaml"
)

// A key that JSON makes one of two, such as 1 and "1", comes from a Go map in
// random order, so a text is read this many times and a reading that moves is
// recorded as unstable.
const readings = 256

type written struct {
	Text string `json:"text"`
	Want string `json:"want"`
}

func main() {
	var cases []string
	unmarshal("cases.json", &cases)
	read := map[string]string{}
	for _, text := range cases {
		read[text] = answer(text)
	}
	report("read.json", "texts", read, write("read.json", read))

	if len(os.Args) < 2 {
		return
	}
	var texts []written
	unmarshal(os.Args[1], &texts)
	different := 0
	digest := sha256.New()
	for _, one := range texts {
		digest.Write([]byte(one.Text))
		digest.Write([]byte{0})
		converted, err := yaml.YAMLToJSON([]byte(one.Text))
		if err != nil {
			different++
			fmt.Printf("%q: %v\n", one.Text, err)
			continue
		}
		var got, want any
		if json.Unmarshal(converted, &got) != nil || json.Unmarshal([]byte(one.Want), &want) != nil || !reflect.DeepEqual(got, want) {
			different++
			fmt.Printf("%q reads as %s, not %s\n", one.Text, converted, one.Want)
		}
	}
	result := map[string]string{"texts": fmt.Sprint(len(texts)), "digest": hex.EncodeToString(digest.Sum(nil))}
	fmt.Printf("written: %d texts, %d read back differently by Go\n", len(texts), different)
	report("written.json", "lines", result, write("written.json", result))
	if different > 0 {
		os.Exit(1)
	}
}

func answer(text string) string {
	var first string
	for i := 0; i < readings; i++ {
		converted, err := yaml.YAMLToJSON([]byte(text))
		answer := string(converted)
		if err != nil {
			answer = "ERROR " + err.Error()
		}
		if i == 0 {
			first = answer
		} else if answer != first {
			return "UNSTABLE"
		}
	}
	return first
}

func unmarshal(path string, into any) {
	raw, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		panic(err)
	}
}

// write keeps what the file held so that report can say what moved.
func write(path string, value map[string]string) map[string]string {
	before := map[string]string{}
	if raw, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(raw, &before); err != nil {
			panic(err)
		}
	}
	out, err := os.Create(path)
	if err != nil {
		panic(err)
	}
	defer out.Close()
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
	return before
}

func report(path, what string, now, before map[string]string) {
	changed := 0
	for key, value := range now {
		if before[key] != value {
			changed++
			fmt.Printf("%s: %q changed: %q, was %q\n", path, key, value, before[key])
		}
	}
	for key := range before {
		if _, kept := now[key]; !kept {
			changed++
			fmt.Printf("%s: %q gone\n", path, key)
		}
	}
	fmt.Printf("%s: %d %s, %d changed\n", path, len(now), what, changed)
}
