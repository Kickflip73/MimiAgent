import { loadMemoryEvalDataset, runMemoryEval } from './runner.js';

runMemoryEval(await loadMemoryEvalDataset())
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    const lexicalQuality = (report.modes.lexical.correct + report.modes.lexical.partial) / report.questionCount;
    const hybridQuality = (report.modes.hybrid.correct + report.modes.hybrid.partial) / report.questionCount;
    if (lexicalQuality < 0.9
      || hybridQuality < 0.9
      || report.modes.lexical.incorrect > 0
      || report.modes.hybrid.incorrect > 0
      || report.modes.lexical.sourceCoverage < 1
      || report.modes.hybrid.sourceCoverage < 1
      || Object.values(report.faults).some((value) => !value)) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
