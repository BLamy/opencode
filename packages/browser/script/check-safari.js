// JavaScriptCore's shell checks module syntax without evaluating browser code.
var failures = []
for (var file of arguments) {
  try {
    checkModuleSyntax(readFile(file))
  } catch (error) {
    failures.push(file + ": " + error)
  }
}
if (failures.length) throw new Error(failures.join("\n"))
print("Safari JavaScriptCore parsed all " + arguments.length + " generated JavaScript files.")
