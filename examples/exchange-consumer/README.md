# Inert exchange consumer

Add a binding named **Counter** from this instance to the example provider. Run
**Connect** after changing the binding. Reading needs no action approval; **Increment**
requires approval for that target module. The optional automatic reset also requires
that approval. It defaults off and only operates on the example's in-memory counter.

Removal or hot replacement makes the target unavailable, then fresh data arrives
from its new generation. Historical actions are never replayed. Dispose unsubscribes.
