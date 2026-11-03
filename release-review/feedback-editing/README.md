# Feedback editing correction

The nine stable packages keep feedback colors/settings editable while feedback is disabled. Action-specific applicability and runtime activation retain their existing rules. Stable IDs, saved sources, API 1 and the SDK/tooling contracts are unchanged.

All nine packages passed their complete package self-tests and archive inspection. The 27-case feedback regression suite and public typecheck pass. Each matrix descriptor exactly matches the previously installed local candidate. The qualified candidate passed real-renderer checks for visible colors, held saves, consecutive edits, incoming feedback, older receipts and failure recovery. TSL includes its color/glow popup. No physical-device actions were exercised.

Module-only candidate activation was verified against unchanged Hubble Agent entry SHA-256 `0b4d878e0247e02fcd0327156e4c78b729c7fe0a60e2c7ecb6ad46799d8a8126` and HubDash ASAR SHA-256 `373b3b0ea268048cb140846691f4f9076d8b9077f5308913eabef1d0da7029aa`. The coordinated host patch adds immediate Cancel handling separately.

The exact stable identities, sizes, digests and immutable URLs are in [modules.lock.json](modules.lock.json). [The reviewed catalog](../feedback-editing-catalog.json) retains every historical entry and advances sequence 6 to 7. Draft uploads are published only by the protected catalog workflow after validating exact archive bytes.
