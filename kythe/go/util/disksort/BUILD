load("//tools:build_rules/shims.bzl", "go_test", "go_library")

package(default_visibility = ["//kythe:default_visibility"])

go_library(
    name = "disksort",
    srcs = ["disksort.go"],
    visibility = [
        "//kythe:default_visibility",
        "//third_party/beam:__pkg__",
    ],
    deps = [
        "//kythe/go/platform/delimited",
        "//kythe/go/util/sortutil",
        "@com_github_golang_snappy//:go_default_library",
    ],
)

go_test(
    name = "disksort_test",
    size = "small",
    srcs = ["disksort_test.go"],
    library = "disksort",
    visibility = ["//visibility:private"],
)
