# OpenShift GitOps — Architecture & Internals

This document explains three things:
1. How ArgoCD is connected to this project
2. How to configure ArgoCD SSO with OpenShift OAuth
3. How BuildConfig + ImageStream work, and **why the `image:` field is intentionally left empty in the Deployments**

---

## 1. How ArgoCD is connected to this project

### The pieces

ArgoCD manages this project through two resources, both stored in `openshift/argocd/`:

```
openshift/argocd/
├── appproject.yaml      # Defines what ArgoCD is allowed to manage
├── applicationset.yaml  # Tells ArgoCD what to deploy and in what order
└── rbac.yaml            # Grants ArgoCD extra permissions it needs
```

### AppProject — the permission boundary

`appproject.yaml` defines a project named `wallpaper-demo` inside ArgoCD. It tells ArgoCD:
- **Which Git repository** it is allowed to read from (`https://github.com/YonathanGuez/rabbitmq-demo-wallpaper-phone`)
- **Which namespaces** it is allowed to deploy into (`wallpaper-demo`, `openshift-gitops`)
- **Which resource types** it is allowed to create (all, including cluster-scoped resources like SCC)

Without an AppProject, ArgoCD cannot manage anything — it is a security boundary.

### ApplicationSet — the deployment plan

`applicationset.yaml` is an ArgoCD controller that generates one **Application** per deployment layer. Instead of creating 5 Applications by hand, the ApplicationSet uses a **List generator** to produce them automatically:

```yaml
generators:
  - list:
      elements:
        - name: wallpaper-infra
          wave: "0"
          include: "{namespace.yaml,pvc.yaml,scc.yaml}"
        - name: wallpaper-rabbitmq
          wave: "1"
          include: "rabbitmq-cluster.yaml"
        - name: wallpaper-server
          wave: "2"
          include: "server.yaml"
        - name: wallpaper-worker
          wave: "3"
          include: "worker.yaml"
        - name: wallpaper-nginx
          wave: "4"
          include: "nginx.yaml"
```

Each element becomes a separate ArgoCD Application pointing to the same Git repo (`openshift/base/`) but including only the files listed in `include`. ArgoCD watches the repo and automatically applies any change pushed to `main`.

### Sync waves — guaranteed deployment order

Each Application carries an annotation:

```yaml
argocd.argoproj.io/sync-wave: "{{wave}}"
```

ArgoCD processes waves in ascending order and **waits for each wave to reach `Healthy` status before starting the next one**. This guarantees:

- Wave 0 (Namespace + PVC + SCC) exists before anything tries to use it
- Wave 1 (RabbitMQ) is running before the server and worker try to connect to it
- Wave 2–4 (application workloads) start only after the infrastructure is ready

### Extra permissions — rbac.yaml

By default, the ArgoCD ServiceAccount (`openshift-gitops-argocd-application-controller`) does not have permission to create cluster-scoped resources like `SecurityContextConstraints` or custom CRDs like `RabbitmqCluster`. `rbac.yaml` creates a `ClusterRole` + `ClusterRoleBinding` that grants those specific permissions:

```yaml
rules:
  - apiGroups: ["rabbitmq.com"]
    resources: ["rabbitmqclusters"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["security.openshift.io"]
    resources: ["securitycontextconstraints"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

### Namespace permissions — the managed-by label

ArgoCD also needs permission to create namespaced resources (Deployments, Services, etc.) inside `wallpaper-demo`. This is handled automatically by labeling the namespace:

```yaml
metadata:
  name: wallpaper-demo
  labels:
    argocd.argoproj.io/managed-by: openshift-gitops
```

OpenShift GitOps detects this label and automatically creates a `RoleBinding` granting the ArgoCD SA full access to that namespace. No manual RoleBinding needed.

---

## 2. ArgoCD SSO with OpenShift OAuth

### How it works

OpenShift GitOps ships with **Dex**, an identity broker pre-configured to use OpenShift OAuth as the identity provider. When a user clicks **"Log in via OpenShift"** on the ArgoCD dashboard, Dex redirects them to the OpenShift OAuth server, which authenticates them and returns their username and group memberships.

```
Browser → ArgoCD dashboard
        → Dex (identity broker, built into OpenShift GitOps)
        → OpenShift OAuth server
        → back to Dex with username + groups
        → back to ArgoCD with a JWT
```

### RBAC mapping

ArgoCD does not trust OpenShift roles directly. It has its own RBAC system configured in the `argocd-rbac-cm` ConfigMap:

```
g, system:cluster-admins, role:admin
g, cluster-admins, role:admin
```

This means: any user who is a member of the OpenShift group `cluster-admins` (or the virtual group `system:cluster-admins`) is granted the ArgoCD `admin` role.

### Why SSO fails without the group

A user can have `cluster-admin` access in OpenShift via a direct `ClusterRoleBinding` and still see an empty ArgoCD dashboard. This is because ArgoCD does not read ClusterRoleBindings — it only reads the group memberships returned by Dex after OAuth login.

If the user is not in any group that the RBAC policy maps to an ArgoCD role, ArgoCD treats them as a read-only user with no project access.

### Fix — add the user to the cluster-admins group

```bash
# Using the deploy script (recommended)
./openshift/deploy.sh --setup-sso             # grants access to the current oc user
./openshift/deploy.sh --setup-sso <username>  # grants access to a specific user
```

What the script does:
1. Creates the OpenShift group `cluster-admins` if it does not exist
2. Adds the user to that group
3. Prints the ArgoCD dashboard URL

After this, log in to the ArgoCD dashboard via **"Log in via OpenShift"**. If you were already logged in, log out first so Dex re-reads your group memberships.

### Why this step is optional in the project

Not every team uses ArgoCD SSO the same way. Some clusters already have the group configured; some use a different group name; some prefer the local `admin` account. The `--setup-sso` flag makes this an explicit opt-in rather than something that silently fails.

---

## 3. BuildConfig + ImageStream — and why `image: ' '`

### The problem with standard image references

In a standard Kubernetes Deployment you write:

```yaml
containers:
  - name: server
    image: my-registry.example.com/wallpaper-server:latest
```

This works fine when you have an external registry. On OpenShift with internal builds, the full image reference changes every time you build (the SHA digest changes). Hardcoding it in Git would mean committing a new SHA after every build — defeating the point of GitOps.

### How OpenShift solves it: ImageStream + trigger

OpenShift introduces two concepts that work together:

**ImageStream** — a stable named reference to an image that lives inside the cluster. You refer to it by name (`wallpaper-server:latest`), and OpenShift tracks which actual image digest is behind that tag. The digest can change (new build) without the name changing.

**ImageStream trigger** — an annotation on a Deployment that tells OpenShift: *"whenever the image behind this ImageStreamTag changes, automatically patch the `image:` field of this container."*

```yaml
metadata:
  annotations:
    image.openshift.io/triggers: >-
      [{"from":{"kind":"ImageStreamTag","name":"wallpaper-server:latest","namespace":"wallpaper-demo"},
        "fieldPath":"spec.template.spec.containers[?(@.name==\"server\")].image",
        "pause":"false"}]
```

When a build completes and pushes a new image to the `wallpaper-server:latest` ImageStreamTag, the OpenShift image controller reads this annotation and patches the Deployment's `image:` field with the new internal registry URL automatically.

### Why `image: ' '` (a single space)

The trigger mechanism patches the `image:` field only if a container with the right name already exists in the spec. The field cannot be empty (`""`) because Kubernetes rejects Deployments with an empty image. So we use a single space (`' '`) as a valid non-empty placeholder that satisfies the Kubernetes API validator but signals clearly that the real value will be injected by the trigger.

```yaml
containers:
  - name: server
    image: ' '    # placeholder — replaced automatically after the first build
```

After the first `oc start-build`, the trigger fires and the field becomes something like:
```
image-registry.openshift-image-registry.svc:5000/wallpaper-demo/wallpaper-server@sha256:abc123...
```

### Why ArgoCD must not revert it

ArgoCD continuously compares the live cluster state with the Git manifest. If it saw that `image:` changed from `' '` to a real SHA, it would try to revert it back to `' '` on the next sync — breaking the deployment.

This is prevented with `ignoreDifferences` in the ApplicationSet:

```yaml
ignoreDifferences:
  - group: apps
    kind: Deployment
    jqPathExpressions:
      - .spec.template.spec.containers[].image
```

Combined with:

```yaml
syncOptions:
  - RespectIgnoreDifferences=true
```

This tells ArgoCD: *"when syncing, do not touch the `image:` field — leave whatever the cluster has."*

**Important:** `ignoreDifferences` must be at the `spec` level of the Application (sibling of `syncPolicy`), not nested inside `syncPolicy`. Placing it inside `syncPolicy` is silently ignored.

### Full flow summary

```
Developer runs: oc start-build bc/wallpaper-server --from-dir=.
        │
        ▼
OpenShift builds the Docker image inside the cluster
        │
        ▼
Image is pushed to the internal registry
        │
        ▼
ImageStreamTag wallpaper-server:latest is updated
        │
        ▼
OpenShift image controller reads the trigger annotation on the Deployment
        │
        ▼
Deployment.spec.template.spec.containers[0].image is patched automatically
        │
        ▼
Kubernetes rolls out the new Pod (old Pod terminates, new one starts)
        │
ArgoCD sees the image field changed but ignores it (ignoreDifferences)
        → No revert, deployment stays live
```

### BuildConfig — binary build strategy

Each service has a `BuildConfig` using the **binary** source strategy:

```yaml
source:
  type: Binary
strategy:
  type: Docker
  dockerStrategy:
    dockerfilePath: Dockerfile
```

`type: Binary` means the build does not pull source from Git — instead, the developer uploads the local directory at build time:

```bash
oc start-build bc/wallpaper-server --from-dir=. -n wallpaper-demo
```

This is why there is no GitHub Actions or webhook — the build is triggered manually from the developer's machine with the local source code. The advantage is that no external CI pipeline or image registry is needed; everything happens inside the OpenShift cluster.
