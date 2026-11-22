import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// ESLint is the SLOW secondary linter in the Biome+ESLint hybrid (ported
// from the reference app). It exists ONLY for the
// custom `no-unrestored-spy` rule — a stateful cross-node AST analysis that
// Biome's GritQL plugins cannot express. Everything else (recommended rules,
// the Zod-over-`as` mandate via plugins/no-object-literal-as-cast.grit,
// formatting) lives in `biome.json`. Keep this config MINIMAL — every rule
// added here costs ~1.3s of TS parsing across all test files.

interface ASTNode {
  type: string;
  parent?: ASTNode;
  name?: string;
  id?: ASTNode;
  left?: ASTNode;
  callee?: ASTNode;
  property?: ASTNode;
  object?: ASTNode;
}

const customTestPlugin = {
  rules: {
    "no-unrestored-spy": {
      meta: {
        type: "problem" as const,
        docs: {
          description:
            "Enforce that spyOn calls are assigned to a variable and restored with mockRestore() to prevent cross-file test pollution.",
        },
        messages: {
          unrestoredSpy:
            'Test spy "{{name}}" created with spyOn() must be restored using .mockRestore() in afterEach/afterAll or a finally block to prevent cross-file pollution.',
          unassignedSpy:
            "Test spy created with spyOn() must be assigned to a variable so .mockRestore() can be called to prevent cross-file pollution.",
        },
      },
      create(context: {
        report: (descriptor: {
          node: ASTNode;
          messageId: string;
          data?: Record<string, string>;
        }) => void;
      }) {
        const spies: Array<{
          name: string;
          node: ASTNode;
        }> = [];
        const restoredNames = new Set<string>();

        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
        function extractSpyVarName(node: ASTNode): string | null {
          let curr = node.parent;
          while (curr) {
            if (
              curr.type === "TSAsExpression" ||
              curr.type === "TSTypeAssertion" ||
              curr.type === "ChainExpression" ||
              curr.type === "SequenceExpression"
            ) {
              curr = curr.parent;
              continue;
            }
            if (
              curr.type === "MemberExpression" &&
              curr.property?.type === "Identifier" &&
              curr.property.name?.startsWith("mock")
            ) {
              curr = curr.parent;
              continue;
            }
            if (curr.type === "CallExpression" && curr.callee?.type === "MemberExpression") {
              curr = curr.parent;
              continue;
            }
            break;
          }
          if (!curr) return null;
          if (curr.type === "VariableDeclarator" && curr.id?.type === "Identifier") {
            return curr.id.name || null;
          }
          if (curr.type === "AssignmentExpression" && curr.left) {
            if (curr.left.type === "Identifier") return curr.left.name || null;
            if (
              curr.left.type === "MemberExpression" &&
              curr.left.property?.type === "Identifier"
            ) {
              return curr.left.property.name || null;
            }
          }
          return null;
        }

        return {
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
          CallExpression(node: ASTNode) {
            const callee = node.callee;
            if (!callee) return;
            const isSpyOn =
              (callee.type === "Identifier" && callee.name === "spyOn") ||
              (callee.type === "MemberExpression" &&
                callee.property?.type === "Identifier" &&
                callee.property.name === "spyOn");

            if (isSpyOn) {
              const varName = extractSpyVarName(node);
              if (!varName) {
                context.report({
                  node,
                  messageId: "unassignedSpy",
                });
              } else {
                spies.push({
                  name: varName,
                  node,
                });
              }
            }

            if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") {
              const propName = callee.property.name;
              if (propName === "mockRestore" || propName === "restore") {
                let obj = callee.object;
                while (
                  obj &&
                  (obj.type === "TSAsExpression" ||
                    obj.type === "TSTypeAssertion" ||
                    obj.type === "ChainExpression")
                ) {
                  obj = (
                    obj as unknown as {
                      expression?: ASTNode;
                    }
                  ).expression;
                }
                if (obj?.type === "Identifier" && obj.name) {
                  restoredNames.add(obj.name);
                } else if (
                  obj?.type === "MemberExpression" &&
                  obj.property?.type === "Identifier" &&
                  obj.property.name
                ) {
                  restoredNames.add(obj.property.name);
                }
              }
            }
          },
          "Program:exit"() {
            for (const { name, node } of spies) {
              if (!restoredNames.has(name)) {
                context.report({
                  node,
                  messageId: "unrestoredSpy",
                  data: {
                    name,
                  },
                });
              }
            }
          },
        };
      },
    },
  },
};

export default defineConfig(
  {
    ignores: [
      "**/build/**",
      "**/dist/**",
      "**/test-results/**",
      "**/node_modules/**",
      "enjoy-the-silence-generated/**",
      "factory-data/**",
      "data/worktrees/**",
    ],
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "tests/**/*.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "custom-test-rules": customTestPlugin,
    },
    rules: {
      "custom-test-rules/no-unrestored-spy": "error",
    },
  },
);
