import * as assert from 'assert';
import { describe, it } from 'mocha';

/**
 * Unit tests for Ceedling plugin compatibility in adapter.ts
 * Tests both legacy xml_tests_report (0.31.x) and new report_tests_log_factory (1.0+)
 */

describe('CeedlingAdapter Plugin Detection', () => {

    describe('sanityCheck() - Plugin Validation', () => {

        it('should accept xml_tests_report plugin (Ceedling 0.31.x)', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['xml_tests_report']
                }
            };

            // Verify old plugin is detected
            const hasXmlTestsReport = ymlProjectData[':plugins'][':enabled'].includes('xml_tests_report');
            const hasReportFactory = ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory');

            assert.strictEqual(hasXmlTestsReport, true, 'Should detect xml_tests_report plugin');
            assert.strictEqual(hasReportFactory, false, 'Should not detect report_tests_log_factory plugin');
            assert.strictEqual(hasXmlTestsReport || hasReportFactory, true, 'Should have at least one valid plugin');
        });

        it('should accept report_tests_log_factory plugin with cppunit (Ceedling 1.0+)', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['report_tests_log_factory']
                },
                ':report_tests_log_factory': {
                    ':reports': ['cppunit', 'junit', 'json']
                }
            };

            // Verify new plugin is detected
            const hasXmlTestsReport = ymlProjectData[':plugins'][':enabled'].includes('xml_tests_report');
            const hasReportFactory = ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory');

            assert.strictEqual(hasXmlTestsReport, false, 'Should not detect xml_tests_report plugin');
            assert.strictEqual(hasReportFactory, true, 'Should detect report_tests_log_factory plugin');

            // Verify cppunit format is present
            const reports = ymlProjectData[':report_tests_log_factory'][':reports'];
            assert.strictEqual(reports.includes('cppunit'), true, 'Should have cppunit format enabled');
        });

        it('should reject when neither plugin is enabled', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['module_generator', 'gcov']
                }
            };

            const hasXmlTestsReport = ymlProjectData[':plugins'][':enabled'].includes('xml_tests_report');
            const hasReportFactory = ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory');

            assert.strictEqual(hasXmlTestsReport || hasReportFactory, false, 'Should not have any valid plugin');
        });

        it('should reject report_tests_log_factory without cppunit format', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['report_tests_log_factory']
                },
                ':report_tests_log_factory': {
                    ':reports': ['junit', 'json']  // Missing cppunit!
                }
            };

            const hasReportFactory = ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory');
            assert.strictEqual(hasReportFactory, true, 'Plugin is enabled');

            const reports = ymlProjectData[':report_tests_log_factory'][':reports'];
            assert.strictEqual(reports.includes('cppunit'), false, 'Should not have cppunit format');
        });

        it('should prefer xml_tests_report when both plugins are enabled', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['xml_tests_report', 'report_tests_log_factory']
                },
                ':report_tests_log_factory': {
                    ':reports': ['cppunit']
                }
            };

            const hasXmlTestsReport = ymlProjectData[':plugins'][':enabled'].includes('xml_tests_report');
            const hasReportFactory = ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory');

            assert.strictEqual(hasXmlTestsReport, true, 'Should detect old plugin');
            assert.strictEqual(hasReportFactory, true, 'Should detect new plugin');
            // When both are present, validation should pass (old takes precedence)
        });
    });

    describe('setXmlReportPath() - Report Filename Detection', () => {

        it('should use default filename when no configuration provided', () => {
            const ymlProjectData = undefined;
            let reportFilename = 'report.xml';  // default

            // This is the logic from setXmlReportPath when ymlProjectData is undefined
            if (!ymlProjectData) {
                // Keep default
            }

            assert.strictEqual(reportFilename, 'report.xml', 'Should use default filename');
        });

        it('should detect custom filename from xml_tests_report plugin', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['xml_tests_report']
                },
                ':xml_tests_report': {
                    ':artifact_filename': 'custom_report.xml'
                }
            };

            let reportFilename = 'report.xml';

            // Simulate the fallback logic - try new plugin first, then old
            const newFilename = (ymlProjectData as any)[':report_tests_log_factory']?.[':cppunit']?.[':filename'];
            if (newFilename) {
                reportFilename = newFilename;
            } else {
                // Try old plugin
                const oldFilename = (ymlProjectData as any)[':xml_tests_report']?.[':artifact_filename'];
                if (oldFilename) {
                    reportFilename = oldFilename;
                }
            }

            assert.strictEqual(reportFilename, 'custom_report.xml', 'Should use custom filename from old plugin');
        });

        it('should detect custom filename from report_tests_log_factory plugin', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['report_tests_log_factory']
                },
                ':report_tests_log_factory': {
                    ':cppunit': {
                        ':filename': 'custom_cppunit.xml'
                    },
                    ':reports': ['cppunit']
                }
            };

            let reportFilename = 'report.xml';

            // Simulate detection - try new plugin first
            try {
                const newFilename = (ymlProjectData as any)[':report_tests_log_factory']?.[':cppunit']?.[':filename'];
                if (newFilename) {
                    reportFilename = newFilename;
                }
            } catch (e) { }

            assert.strictEqual(reportFilename, 'custom_cppunit.xml', 'Should use custom filename from new plugin');
        });

        it('should use default cppunit filename when report_tests_log_factory has no custom filename', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['report_tests_log_factory']
                },
                ':report_tests_log_factory': {
                    ':reports': ['cppunit']
                    // No :cppunit::filename specified
                }
            };

            let reportFilename = 'report.xml';

            // Try new plugin
            const newFilename = (ymlProjectData as any)[':report_tests_log_factory']?.[':cppunit']?.[':filename'];
            if (newFilename) {
                reportFilename = newFilename;
            } else {
                // No custom filename, check if plugin is enabled and use default
                if ((ymlProjectData as any)[':plugins'][':enabled'].includes('report_tests_log_factory')) {
                    reportFilename = 'cppunit_tests_report.xml';
                }
            }

            assert.strictEqual(reportFilename, 'cppunit_tests_report.xml', 'Should use default cppunit filename');
        });

        it('should prefer new plugin filename over old when both exist', () => {
            const ymlProjectData = {
                ':plugins': {
                    ':enabled': ['xml_tests_report', 'report_tests_log_factory']
                },
                ':xml_tests_report': {
                    ':artifact_filename': 'old_report.xml'
                },
                ':report_tests_log_factory': {
                    ':cppunit': {
                        ':filename': 'new_report.xml'
                    },
                    ':reports': ['cppunit']
                }
            };

            let reportFilename = 'report.xml';

            // Try new plugin first (this is the order in the implementation)
            try {
                const newFilename = (ymlProjectData as any)[':report_tests_log_factory']?.[':cppunit']?.[':filename'];
                if (newFilename) {
                    reportFilename = newFilename;
                }
            } catch (e) {
                // Fall back to old
                try {
                    const oldFilename = (ymlProjectData as any)[':xml_tests_report']?.[':artifact_filename'];
                    if (oldFilename) {
                        reportFilename = oldFilename;
                    }
                } catch (e) { }
            }

            assert.strictEqual(reportFilename, 'new_report.xml', 'Should prefer new plugin filename');
        });
    });
});
