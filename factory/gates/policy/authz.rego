# Authorization policy, evaluated outside the application.
#
# Move the rules that answer "may this actor do this to this object?" here, then run
# them in CI:
#
#   conftest test --policy enforcement/policy request.json
#
# Why outside: a policy that lives only inside handlers is tested by the handlers, by
# the people who wrote them, with the happy path already in mind. This file is a
# deny-by-default skeleton — the default is failure, so a missing rule refuses rather
# than permits.

package authz

default allow = false

# Input shape (one request, as recorded by the test that exercises it):
#   { "actor": {"id": "...", "roles": [...], "tenant": "..."},
#     "action": "read" | "write" | "delete",
#     "object": {"owner": "...", "tenant": "..."} }
#
# Replace the body of `tenant_matches` and `owns` with the real rules; keep `default
# allow = false` exactly as it is.

tenant_matches {
  input.actor.tenant == input.object.tenant
}

owns {
  input.actor.id == input.object.owner
}

allow {
  tenant_matches
  owns
}
