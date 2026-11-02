# CCC 1.2.7 qualification

CCC's camera document table declares the generic `module-table-live-v1` host
feature and publishes pending enabled values with the current opaque document
revision. Camera selections can appear on the page before durable saves finish.
The shared host protects local edits and excludes unedited live values from
portable document data. Module API 1 and saved camera IDs/formats are unchanged.

This package requires a host advertising `module-table-live-v1`, minimum version
2.0.15. A version number alone is insufficient; older 2.0.15 hosts reject the
package until updated. Keep CCC 1.2.6 available for those hosts.

The public checkout passed 63 focused CCC/SDK tests and TypeScript checks.
Held-write tests cover pending selection and success/failure recovery. Package
build, test and inspection passed. Archive SHA-256:
`13c97672fdd506d6ac837da9ba7063dcd7b9caef89ecef6dd56902f4b771140f`.

The isolated host runtime exercised page selection controls and 32 queued local
selection commands without a worker restart. A live observation arrived after
16 ms in that fixture. This does not establish production save latency or
physical camera acceptance. No recording commands were issued.

Developer kit 1.7.0-dev.4 includes the additive declaration and canonical native
workbook guidance. An extracted generic document example was built, tested,
validated, packed and inspected with a live column declaration, without using
the private host checkout. The first local kit candidate exposed AppleDouble
sidecars on extraction and was rejected; final packaging excludes those sidecars.
Final kit SHA-256:
`375f08840e7120235caaae1283679c049d3b643a6c6ab4e264c8f90d6dcc4608`.

The signed matching host was installed and CCC 1.2.7 selected through its public
module API. The installed page shows all 16 camera rows and reports ready; host
hashes remained unchanged by the module import/selection. A separate isolated
service using the exact packaged host proved the 1.2.6-to-1.2.7 page declaration
and behavior update against unchanged app bytes. Its first live observation took
14 ms, and 32 queued selections completed without a worker restart. Production
workbook data and button configuration were preserved. Operator acceptance of
the page's perceived responsiveness is pending.
