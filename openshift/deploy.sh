#!/usr/bin/env bash
# deploy.sh — Build and deploy wallpaper-demo on OpenShift
#
# Usage:
#   ./openshift/deploy.sh                        # build all 3 images + wait
#   ./openshift/deploy.sh --skip-builds          # push git changes only (ArgoCD syncs)
#   ./openshift/deploy.sh --bootstrap            # first-time setup (AppProject + ApplicationSet + RabbitMQ secret)
#   ./openshift/deploy.sh --setup-sso [user]     # grant ArgoCD SSO access (optional, default: current oc user)
#   ./openshift/deploy.sh --status               # show current status of all components
#
# Prerequisites:
#   - oc login already done
#   - kubectl/oc in PATH

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-wallpaper-demo}"
ARGOCD_NS="${ARGOCD_NS:-openshift-gitops}"
RABBITMQ_CLUSTER="${RABBITMQ_CLUSTER:-my-rabbitmq}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ─── Check prerequisites ──────────────────────────────────────────────────────
check_prereqs() {
  command -v oc &>/dev/null  || error "oc not found in PATH"
  oc whoami &>/dev/null      || error "Not logged in to OpenShift. Run: oc login <cluster>"
  info "Logged in as: $(oc whoami) on $(oc whoami --show-server)"
}

# ─── SSO setup (optional) ─────────────────────────────────────────────────────
setup_sso() {
  local TARGET_USER="${1:-$(oc whoami)}"
  info "Granting ArgoCD SSO access to user: $TARGET_USER"

  if oc get group cluster-admins &>/dev/null; then
    warn "Group 'cluster-admins' already exists"
  else
    oc adm groups new cluster-admins
    success "Group 'cluster-admins' created"
  fi

  oc adm groups add-users cluster-admins "$TARGET_USER"
  success "User '$TARGET_USER' added to 'cluster-admins'"

  ARGOCD_URL="https://$(oc get route openshift-gitops-server -n "$ARGOCD_NS" -o jsonpath='{.spec.host}')"
  success "Log in to ArgoCD via SSO (OpenShift OAuth): $ARGOCD_URL"
  info "If already logged in, log out and back in for the new group to take effect."
}

# ─── Status ───────────────────────────────────────────────────────────────────
show_status() {
  echo ""
  info "=== ArgoCD Applications ==="
  oc get applications -n "$ARGOCD_NS" -l app.kubernetes.io/part-of=wallpaper-demo 2>/dev/null || \
    warn "No applications found (run --bootstrap first)"

  echo ""
  info "=== Pods in $NAMESPACE ==="
  oc get pods -n "$NAMESPACE" 2>/dev/null || warn "Namespace $NAMESPACE not found"

  echo ""
  info "=== Route ==="
  oc get route -n "$NAMESPACE" 2>/dev/null || true

  echo ""
  info "=== Builds ==="
  oc get builds -n "$NAMESPACE" 2>/dev/null || true
}

# ─── Bootstrap (first-time setup) ────────────────────────────────────────────
bootstrap() {
  info "Starting bootstrap..."

  info "Applying AppProject..."
  oc apply -f "$SCRIPT_DIR/argocd/appproject.yaml"

  info "Applying ApplicationSet..."
  oc apply -f "$SCRIPT_DIR/argocd/applicationset.yaml"

  info "Applying ArgoCD extra permissions..."
  oc apply -f "$SCRIPT_DIR/argocd/rbac.yaml"

  info "Waiting for namespace $NAMESPACE to be created by ArgoCD (wave 0)..."
  for i in $(seq 1 30); do
    oc get namespace "$NAMESPACE" &>/dev/null && break
    sleep 5
    echo -n "."
  done
  echo ""
  oc get namespace "$NAMESPACE" &>/dev/null || error "Namespace $NAMESPACE was not created"
  success "Namespace $NAMESPACE ready"

  info "Waiting for RabbitMQ to be ready (wave 1)..."
  for i in $(seq 1 60); do
    READY=$(oc get rabbitmqcluster "$RABBITMQ_CLUSTER" -n "$NAMESPACE" \
      -o jsonpath='{.status.conditions[?(@.type=="AllReplicasReady")].status}' 2>/dev/null || echo "")
    [[ "$READY" == "True" ]] && break
    sleep 10
    echo -n "."
  done
  echo ""
  [[ "$READY" == "True" ]] || warn "RabbitMQ not ready yet — you may need to wait and create the secret manually"

  info "Creating RabbitMQ credentials secret..."
  if oc get secret wallpaper-rabbitmq -n "$NAMESPACE" &>/dev/null; then
    warn "Secret wallpaper-rabbitmq already exists, skipping"
  else
    RMQUSER=$(oc get secret "${RABBITMQ_CLUSTER}-default-user" -n "$NAMESPACE" \
      -o jsonpath='{.data.username}' | base64 -d)
    RMQPASS=$(oc get secret "${RABBITMQ_CLUSTER}-default-user" -n "$NAMESPACE" \
      -o jsonpath='{.data.password}' | base64 -d)
    oc create secret generic wallpaper-rabbitmq \
      --from-literal=RABBITMQ_URL="amqp://${RMQUSER}:${RMQPASS}@${RABBITMQ_CLUSTER}.${NAMESPACE}.svc.cluster.local:5672" \
      -n "$NAMESPACE"
    success "Secret wallpaper-rabbitmq created"
  fi

  success "Bootstrap done — running builds..."
  run_builds
}

# ─── Build images ─────────────────────────────────────────────────────────────
wait_for_build() {
  local BC=$1
  info "Waiting for build $BC to complete..."
  for i in $(seq 1 60); do
    STATUS=$(oc get build "${BC}-$(oc get buildconfig "$BC" -n "$NAMESPACE" \
      -o jsonpath='{.status.lastVersion}')" -n "$NAMESPACE" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "Pending")
    case "$STATUS" in
      Complete) success "Build $BC: Complete"; return 0 ;;
      Failed|Error|Cancelled) error "Build $BC failed with status: $STATUS" ;;
    esac
    sleep 10
    echo -n "."
  done
  echo ""
  error "Build $BC timed out"
}

run_builds() {
  cd "$REPO_ROOT"

  info "Starting build: wallpaper-server"
  oc start-build bc/wallpaper-server --from-dir=. -n "$NAMESPACE"

  info "Starting build: wallpaper-worker"
  oc start-build bc/wallpaper-worker --from-dir=. -n "$NAMESPACE"

  info "Starting build: wallpaper-nginx"
  oc start-build bc/wallpaper-nginx --from-dir=. -n "$NAMESPACE"

  wait_for_build wallpaper-server
  wait_for_build wallpaper-worker
  wait_for_build wallpaper-nginx

  echo ""
  success "All builds complete — ImageStream triggers will update Deployments automatically"
  echo ""
  show_status
}

# ─── Main ─────────────────────────────────────────────────────────────────────
check_prereqs

case "${1:-}" in
  --bootstrap)   bootstrap ;;
  --setup-sso)   setup_sso "${2:-}" ;;
  --skip-builds) info "Skipping builds — ArgoCD will sync git changes automatically"; show_status ;;
  --status)      show_status ;;
  "")            run_builds ;;
  *) echo "Usage: $0 [--bootstrap | --setup-sso [user] | --skip-builds | --status]"; exit 1 ;;
esac
