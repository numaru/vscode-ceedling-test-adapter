# Ceedling Test Explorer for Visual Studio Code

Run your [Ceedling](https://github.com/ThrowTheSwitch/Ceedling) tests using the 
[Test Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer).

![Screenshot](img/screenshot.png)

## Features

* Shows a Test Explorer in the Test view in VS Code's sidebar with all detected tests and suites and their state
* Adds CodeLenses to your test files for starting and debugging tests
* Adds Gutter decorations to your test files showing the tests' state
* Adds line decorations to the source line where a test failed
* Shows a failed test's log when the test is selected in the explorer
* Lets you choose test suites that should be run automatically after each file change
* Can be set up to report compiler and linker problems inline in the editor and in the Problems panel.

## Getting started

* Install the extension and restart VS Code
* Open the workspace or folder containing your Ceedling project
* Configure your `project.yml` path in the VS Code's settings if required [see below](#options)
* Configure the shell path where Ceedling is installed in the VS Code's settings if required (It might be required on Windows) [see below](#options)
* Enable the `xml_tests_report` Ceedling plugin in your `project.yml` [see the Ceedling doc](https://github.com/ThrowTheSwitch/Ceedling/blob/master/docs/CeedlingPacket.md#tool-element-runtime-substitution-notational-substitution)
* Open the Test view
* Run your tests using the ![Run](img/run.png) icons in the Test Explorer or the CodeLenses in your test file

## Configuration

### Options

Property                                | Description
----------------------------------------|---------------------------------------------------------------
`ceedlingExplorer.projectPath`          | The path to the Ceedling project (where the `project.yml` is) to use (relative to the workspace folder). By default (or if this option is set to `null`) it use the same path as the workspace folder.
`ceedlingExplorer.shellPath`            | The path to the shell where Ceedling is installed. By default (or if this option is set to `null`) it use the OS default shell.
`ceedlingExplorer.debugConfiguration`   | The Debug configuration to run during debugging. See Debugging for more info.  
`ceedlingExplorer.prettyTestLabel`      | The test label is prettier in the test explorer, that mean the label is shorter and without begin prefix. E.g. inactive `test_BlinkTaskShouldToggleLed`, active `BlinkTaskShouldToggleLed` <br> Inactive: <br> ![prettyTestLabelInactive](img/prettyTestLabelInactive.png) <br> Active: <br> ![prettyTestLabelActive](img/prettyTestLabelActive.png)
`ceedlingExplorer.prettyTestFileLabel`  | The test file label is prettier in the test explorer, that mean the label is shorter, without begin prefix, path and file type. E.g. inactive `test/LEDs/test_BlinkTask.c`, active `BlinkTask` <br> Inactive: <br> ![prettyTestFileLabelInactive](img/prettyTestFileLabelInactive.png) <br> Active: <br> ![prettyTestFileLabelActive](img/prettyTestFileLabelActive.png)
`ceedlingExplorer.testCommandArgs`      | The command line arguments used to run Ceedling tests. The first argument have to litteraly contain the `${TEST_ID}` tag. The value `["test:${TEST_ID}"]` is used by default. For example, the arguments `"test:${TEST_ID}", "gcov:${TEST_ID}", "utils:gcov"` can be used to run tests and generate a gcov report.
`ceedlingExplorer.problemMatching`      | Configuration of compiler/linker problem matching. See [Problem matching](#problem%20matching) section for details.
`ceedlingExplorer.testCaseMacroAliases` | An array of aliases for the `TEST_CASE` macro. By default it is `["TEST_CASE"]`
`ceedlingExplorer.testRangeMacroAliases`| An array of aliases for the `TEST_RANGE` macro. By default it is `["TEST_RANGE"]`
`ceedlingExplorer.ansiEscapeSequencesRemoved`| Should the ansi escape sequences be removed from ceedling stdout and stderr. By default it is `true`
<br>

### Problem matching

Problem matching is the mechanism that scans Ceedling output text for known error/warning/info strings and reports these inline in the editor and in the Problems panel. Tries to resemble VSCode Tasks problemMatchers mechanism.

![problems](img/problems.png)

Problem matching configuration options:
Property           | Description
-------------------|---------------------------------------------------------------
`mode`             | Mode of problem matching. It is either "disabled", uses preset (i.e. "gcc") or uses custom "patterns" from patterns array. Default is "disabled".
`patterns`         | Array of custom pattern objects used for problem matching. If mode is set to "patterns", Ceedling output is scanned line by line using each pattern provided in this array. Default is empty array.
<br>

Example configuration which is sufficient in most cases:
```json
"ceedlingExplorer.problemMatching": {
	"mode": "gcc"
}
```

Problem matching pattern options:
Property&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;| Description
-------------------|---------------------------------------------------------------
`scanStdout`       | Scan stdout output for problems. Default is false.
`scanStderr`       | Scan stderr output for problems. Default is true.
`severity`         | Severity of messages found by this pattern. Correct values are "error", "warning" and "info". Default is "info".
`filePrefix`       | Used to determine file's absolute path if file location is relative. ${projectPath} replaced with project path. Empty string means that file location in message is absolute. Default is empty string.
`regexp`           | The regular expression which is used to find an error, warning or info in the output line. ECMAScript (JavaScript) flavor, with global flag. Tip: you may find [regex101](https://regex101.com/) useful while experimenting with patterns. This property is required.
`message`          | Index of the problem's message in the regular expression. This property is required.
`file`             | Index of the problem's filename in the regular expression. This property is required.
`line`             | Index of the problem's (first) line in the regular expression. Not used if null or not defined.
`lastLine`         | Index of the problem's last line in the regular expression. Not used if null or not defined."
`column`           | Index of the problem's (first) column in the regular expression. Not used if null or not defined.
`lastColumn`       | Index of the problem's last column in the regular expression. Not used if null or not defined.
<br>

Example pattern object (GCC compiler warnings):
```json
{
    "severity": "warning",
    "filePrefix": "${projectPath}",
    "regexp": "^(.*):(\\d+):(\\d+):\\s+warning:\\s+(.*)$",
    "message": 4,
    "file": 1,
    "line": 2,
    "column": 3
}
```

## Commands

The following commands are available in VS Code's command palette, use the ID to add them to your keyboard shortcuts:

ID                                 | Command
-----------------------------------|--------------------------------------------
`ceedlingExplorer.clean`           | Run `ceedling clean`
`ceedlingExplorer.clobber`         | Run `ceedling clobber`
`test-explorer.reload`             | Reload tests
`test-explorer.run-all`            | Run all tests
`test-explorer.run-file`           | Run tests in current file
`test-explorer.run-test-at-cursor` | Run the test at the current cursor position
`test-explorer.cancel`             | Cancel running tests

## Debugging

To set up debugging, create a new Debug Configuration. `${command:ceedlingExplorer.debugTestExecutable}` 
can be used access the .out test executable filename being ran. Depending on your Ceedling configuration these can be found in `projectPath/build/test/out/`.
Then, edit the `ceedlingExplorer.debugConfiguration` settings with the name of the Debug Configuration to run during debug.

Note: Individual test debugging is not supported. Instead the entire test file will be ran, so skip or remove breakpoints accordingly.

Example configuration with Native Debug (`webfreak.debug`):
```json
{
    "name": "Ceedling Test Explorer Debug",
    "type": "cppdbg",
    "request": "launch",
    "program": "${workspaceFolder}/build/test/out/${command:ceedlingExplorer.debugTestExecutable}",
    "args": [],
    "stopAtEntry": false,
    "cwd": "${workspaceFolder}",
    "environment": [],
    "externalConsole": false,
    "MIMode": "gdb",
    "miDebuggerPath": "C:/MinGW/bin/gdb.exe",
    "setupCommands": [
        {
            "description": "Enable pretty-printing for gdb",
            "text": "-enable-pretty-printing",
            "ignoreFailures": true
        }
    ]
}
```

`Ceedling` changed the path to the executable program in different versions of `Ceedling`.
Based on the example configuration shown above the `program` key needs to be configured accordingly to the `Ceedling` version as follows:

| `Ceedling` version | `program` key setting                                                                                                        |
|--------------------|------------------------------------------------------------------------------------------------------------------------------|
| <= 0.31.1          | `${workspaceFolder}/build/test/out/${command:ceedlingExplorer.debugTestExecutable}`                                          |
| >= 0.32.0          | `${workspaceFolder}/build/test/out/${command:ceedlingExplorer.testFileName}/${command:ceedlingExplorer.debugTestExecutable}` |

## Known issues

* Cannot use both the junit Ceedling plugin and the xml plugin required by this extension because they are using the same ouput filename by default. If the version of the Ceedling you are using is greather than 0.28.3, you should be able to configure the output filename. [#20](https://github.com/numaru/vscode-ceedling-test-adapter/issues/20)

## Troubleshooting

If you think you've found a bug, please [file a bug report](https://github.com/numaru/vscode-ceedling-test-adapter/issues).
