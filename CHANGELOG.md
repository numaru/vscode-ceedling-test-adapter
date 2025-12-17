# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.13.1] - 2025-12-17

### Fixed

* Add the missing `rimraf` dependency.

## [1.13.0] - 2025-12-17

### Added

* Add support for ruby `#{ENV['FOO']}` syntax.
* Add support for Ceedling 1.0+ `report_tests_log_factory` plugin with CppUnit format.
* Add `ceedlingExplorer.debugTestExecutablePath` command that returns the full path to test executable.
* Add `isCeedling1Plus()` helper method for reliable Ceedling 1.0+ detection using plugin configuration.
* Add configuration documentation for both Ceedling versions in README.

### Fixed

* Fix compatibility with Ceedling 1.0+ (addresses issues #137 and #145).
* Fix debug executable path detection for Ceedling 1.0+ by checking for `report_tests_log_factory` plugin instead of relying on version string parsing.
* Ensure test executables in subdirectories (e.g., `test_name/test_name.out`) are correctly located for debugging.

## [1.12.0] - 2024-01-02

### Added

* Add debug compatibility for ceedling >= v0.32.0.
* Use the esbuild bundler to shrink the size of the release.

## [1.11.0] - 2023-11-29

### Added

* Add a vscode log channel for the extension.

### Fixed

* Do not use the path as test suite id, only the file name.

## [1.10.1] - 2022-06-07

### Fixed

* Fix the async-mutex import.

## [1.10.0] - 2022-06-04

### Added

* A option to remove the ANSI escape sequences.

## [1.9.1] - 2022-04-15

### Fixed

* Allow to debug on a multiple folders workspace.
* Run the `Clean` and `Clobber` commands on all root folders of the workspace.

## [1.9.0] - 2022-04-03

### Added

* A configurable aliases for the parameterized test macros `TEST_CASE` and `TEST_RANGE`.

## [1.8.2] - 2021-04-21

### Fixed

* Choose the right report.xml when using gcov.

## [1.8.1] - 2021-02-17

### Fixed

* Fix the "always use default projectPath" issue.

## [1.8.0] - 2021-02-15

### Added

* Add support for `TEST_CASE` and `TEST_RANGE` parameterized tests.

### Fixed

* Do not run ceedling from an unexisting directory.

## [1.7.0] - 2021-01-11

### Added

* Add the `Clean` and `Clobber` commands.

## [1.6.0] - 2020-10-09

### Added

* Add the errors reported by the ceedling build tools to the `PROBLEMS` tab. It should be enabled using the `ceedlingExplorer.problemMatching` option.

## [1.5.2] - 2020-07-06

### Fixed

* Fix of double autorun triggering on test file save
* Report errored tests properly

## [1.5.1] - 2020-04-22

### Fixed

* Support for multiline test function name

## [1.5.0] - 2020-04-20

### Added

* Add the `ceedlingExplorer.testCommandArgs` option to be able to run `gcov`
* Add the `ceedlingExplorer.prettyTestLabel` and `ceedlingExplorer.prettyTestFileLabel` options for the sake of beauty

## [1.4.2] - 2019-11-30

### Fixed

* Correct the `ceedlingExplorer.debugTestExecutable` path of tests with specific defines

## [1.4.1] - 2019-09-16

### Fixed

* Determine debugged executable extension based on OS
* Allow debug in vscode multi directory workspace

## [1.4.0] - 2019-08-06

### Added

* Detect build directory path from project.yml

### Fixed

* No tests appearing when `:unity` is defined but not `:test_prefix`

## [1.3.0] - 2019-06-05

### Added

* Detect xml report path from project.yml

### Changed

* Uprade some dependencies for security reasons

## [1.2.1] - 2019-02-28

### Fixed

* The debug of the failing tests is now possible

## [1.2.0] - 2019-02-12

### Added

* Add the debug feature

### Changed

* Uprading the dependencies

## [1.1.3] - 2018-10-11

### Changed

* Do not complain about bad configuration when a non ceedling project is opened

## [1.1.2] - 2018-10-08

### Changed

* Fix the bug which was causing infinity loop on reload using cmd.exe shell

## [1.1.1] - 2018-10-07

### Changed

* Fix the wrong line number for test if there is more than one line feed before

## [1.1.0] - 2018-10-07

### Added

* Add `shellPath` option to use the shell where ceedling is installed

## 1.0.0 - 2018-09-23

### Added

* Initial features

[Unreleased]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.13.1...develop
[1.13.1]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.13.0...v1.13.1
[1.13.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.8.2...v1.9.0
[1.8.2]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.5.1...v1.6.0
[1.5.2]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.4.2...v1.5.0
[1.4.2]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.0.0...v1.1.0
