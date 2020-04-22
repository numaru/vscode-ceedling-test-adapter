# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/numaru/vscode-ceedling-test-adapter/compare/v1.5.0...develop
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
