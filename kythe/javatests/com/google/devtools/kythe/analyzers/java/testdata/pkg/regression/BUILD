load("//tools/build_rules/verifier_test:verifier_test.bzl", "java_verifier_test")

java_library(
    name = "regression",
    srcs = glob(
        ["**/*.java"],
    ),
    visibility = ["//kythe/javatests/com/google/devtools/kythe/analyzers/java/testdata:__subpackages__"],
)

java_verifier_test(
    name = "nullable_test",
    size = "small",
    srcs = ["Nullable.java"],
)
