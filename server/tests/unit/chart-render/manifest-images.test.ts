/**
 * The YAML walk that extracts what a rendered chart deploys —
 * measuring-candidate-charts.md phase 2.
 *
 * The load-bearing assertions are the negative ones: images referenced only
 * inside operator flags or CRD payloads are NOT guessed at, and test-hook
 * manifests are NOT counted as something the chart deploys.
 */

import { describe, it, expect } from "vitest";
import { extractPodImages } from "../../../src/chart-render/manifest-images.js";

describe("extractPodImages", () => {
    it("collects images from every PodSpec location Kubernetes defines", () => {
        const rendered = `
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.25
      initContainers:
        - name: init
          image: busybox:1.36
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: quay.io/backup/tool:v2
---
apiVersion: v1
kind: Pod
metadata:
  name: debug
spec:
  containers:
    - name: main
      image: alpine:3.20
  ephemeralContainers:
    - name: shell
      image: ghcr.io/tools/shell:latest
`;
        expect(extractPodImages(rendered)).toEqual([
            "alpine:3.20",
            "busybox:1.36",
            "ghcr.io/tools/shell:latest",
            "nginx:1.25",
            "quay.io/backup/tool:v2",
        ]);
    });

    it("includes hook resources — they run at install and their images are real", () => {
        const rendered = `
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: acme/migrator:1.0
`;
        expect(extractPodImages(rendered)).toEqual(["acme/migrator:1.0"]);
    });

    it("excludes test manifests — helm test images do not run in normal operation", () => {
        const rendered = `
apiVersion: v1
kind: Pod
metadata:
  name: connection-test
  annotations:
    "helm.sh/hook": test
spec:
  containers:
    - name: test
      image: busybox:1.36
---
apiVersion: v1
kind: Pod
metadata:
  name: legacy-test
  annotations:
    "helm.sh/hook": test-success
spec:
  containers:
    - name: test
      image: busybox:1.35
`;
        expect(extractPodImages(rendered)).toEqual([]);
    });

    it("does not extract images from operator flags or CRD payloads", () => {
        // The prometheus-operator config-reloader pattern: the image exists
        // only as a container argument. It is a known gap, surfaced later as
        // unmeasuredImages — never guessed at here.
        const rendered = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: operator
spec:
  template:
    spec:
      containers:
        - name: operator
          image: quay.io/prometheus-operator/prometheus-operator:v0.75.0
          args:
            - --prometheus-config-reloader=quay.io/prometheus-operator/prometheus-config-reloader:v0.75.0
---
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: k8s
spec:
  image: quay.io/prometheus/prometheus:v2.54.0
`;
        expect(extractPodImages(rendered)).toEqual([
            "quay.io/prometheus-operator/prometheus-operator:v0.75.0",
        ]);
    });

    it("lets a malformed document cost itself, not the stream", () => {
        const rendered = `
apiVersion: v1
kind: Pod
metadata:
  name: good
spec:
  containers:
    - name: main
      image: nginx:1.25
---
{ this is : not : valid yaml ::::
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: also-good
spec:
  template:
    spec:
      containers:
        - name: main
          image: redis:7.2
`;
        expect(extractPodImages(rendered)).toEqual(["nginx:1.25", "redis:7.2"]);
    });

    it("deduplicates and ignores kinds without a PodSpec", () => {
        const rendered = `
apiVersion: v1
kind: Service
metadata:
  name: svc
spec:
  ports: [{ port: 80 }]
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: agent-a
spec:
  template:
    spec:
      containers:
        - name: agent
          image: acme/agent:1.0
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: agent-b
spec:
  template:
    spec:
      containers:
        - name: agent
          image: acme/agent:1.0
`;
        expect(extractPodImages(rendered)).toEqual(["acme/agent:1.0"]);
    });

    it("returns nothing for empty or non-YAML input", () => {
        expect(extractPodImages("")).toEqual([]);
        expect(extractPodImages("just a plain sentence")).toEqual([]);
    });
});
