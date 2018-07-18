/*
 * Copyright 2015 The Kythe Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Binary gotool extracts Kythe compilation information for Go packages named
// by import path on the command line.  The output compilations are written
// into an index pack directory.
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"go/build"
	"log"
	"os"
	"path/filepath"
	"strings"

	"kythe.io/kythe/go/extractors/golang"
	"kythe.io/kythe/go/platform/kindex"
	"kythe.io/kythe/go/platform/kzip"
	"kythe.io/kythe/go/platform/vfs"
)

var (
	bc = build.Default // A shallow copy of the default build settings

	corpus     = flag.String("corpus", "", "Default corpus name to use")
	localPath  = flag.String("local_path", "", "Directory where relative imports are resolved")
	outputPath = flag.String("output", "", "Output path (indexpack directory or .kzip filename)")
	extraFiles = flag.String("extra_files", "", "Additional files to include in each compilation (CSV)")
	byDir      = flag.Bool("bydir", false, "Import by directory rather than import path")
	keepGoing  = flag.Bool("continue", false, "Continue past errors")
	verbose    = flag.Bool("v", false, "Enable verbose logging")
)

func init() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, `Usage: %s [options] <import-path>...
Extract Kythe compilation records from Go import paths specified on the command line.
Outputs are written to an index pack unless --kindex is set, in which case they
are written to individual .kindex files in the output directory.

Options:
`, filepath.Base(os.Args[0]))
		flag.PrintDefaults()
	}

	// Attach flags to the various parts of the go/build context we are using.
	// These will override the system defaults from the environment.
	flag.StringVar(&bc.GOARCH, "goarch", bc.GOARCH, "Go system architecture tag")
	flag.StringVar(&bc.GOOS, "goos", bc.GOOS, "Go operating system tag")
	flag.StringVar(&bc.GOPATH, "gopath", bc.GOPATH, "Go library path")
	flag.StringVar(&bc.GOROOT, "goroot", bc.GOROOT, "Go system root")
	flag.BoolVar(&bc.CgoEnabled, "gocgo", bc.CgoEnabled, "Whether to allow cgo")
	flag.StringVar(&bc.Compiler, "gocompiler", bc.Compiler, "Which Go compiler to use")

	// TODO(fromberger): Attach flags to the build and release tags (maybe).
}

func maybeFatal(msg string, args ...interface{}) {
	log.Printf(msg, args...)
	if !*keepGoing {
		os.Exit(1)
	}
}

func maybeLog(msg string, args ...interface{}) {
	if *verbose {
		log.Printf(msg, args...)
	}
}

func main() {
	flag.Parse()

	if *outputPath == "" {
		log.Fatal("You must provide a non-empty --output path")
	}

	ctx := context.Background()
	ext := &golang.Extractor{
		BuildContext: bc,
		Corpus:       *corpus,
		LocalPath:    *localPath,
	}
	if *extraFiles != "" {
		ext.ExtraFiles = strings.Split(*extraFiles, ",")
	}

	locate := ext.Locate
	if *byDir {
		locate = ext.ImportDir
	}
	for _, path := range flag.Args() {
		pkg, err := locate(path)
		if err == nil {
			maybeLog("Found %q in %s", pkg.Path, pkg.BuildPackage.Dir)
		} else {
			maybeFatal("Error locating %q: %v", path, err)
		}
	}

	if err := ext.Extract(); err != nil {
		maybeFatal("Error in extraction: %v", err)
	}

	maybeLog("Writing %d package(s) to %q", len(ext.Packages), *outputPath)
	w, err := kzipWriter(ctx, *outputPath)
	if err != nil {
		maybeFatal("Error creating kzip writer: %v", err)
	}
	for _, pkg := range ext.Packages {
		maybeLog("Package %q:\n\t// %s", pkg.Path, pkg.BuildPackage.Doc)
		if err := pkg.EachUnit(ctx, func(cu *kindex.Compilation) error {
			if _, err := w.AddUnit(cu.Proto, nil); err != nil {
				return err
			}
			for _, fd := range cu.Files {
				if _, err := w.AddFile(bytes.NewReader(fd.Content)); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			maybeFatal("Error writing %q: %v", pkg.Path, err)
		}
	}
	if err := w.Close(); err != nil {
		maybeFatal("Error closing output: %v", err)
	}
}

func kzipWriter(ctx context.Context, path string) (*kzip.Writer, error) {
	if err := vfs.MkdirAll(ctx, filepath.Dir(path), 0755); err != nil {
		log.Fatalf("Unable to create output directory: %v", err)
	}
	f, err := vfs.Create(ctx, path)
	if err != nil {
		log.Fatalf("Unable to create output file: %v", err)
	}
	return kzip.NewWriteCloser(f)
}
