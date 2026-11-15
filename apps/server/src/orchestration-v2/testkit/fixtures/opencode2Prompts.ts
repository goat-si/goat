export const OPENCODE2_SIMPLE_PROMPT =
  "Think carefully step by step about whether 391 is prime, showing your reasoning, then answer in one short sentence.";
export const OPENCODE2_TOOL_CALL_PROMPT =
  "Use the read tool to read hello.txt, then run the shell command `echo TOOL_OK` with the bash tool, then reply DONE.";
export const OPENCODE2_INTERRUPT_PROMPT =
  "Run the shell command `sleep 60 && echo LATE` with the bash tool, then reply DONE.";
export const OPENCODE2_PERMISSION_PROMPT =
  "Run the shell command `echo FIRST` with the bash tool. After it completes, run `echo SECOND` with the bash tool. Then reply with what happened.";
export const OPENCODE2_STEER_PROMPT =
  "Run the shell command `sleep 12 && echo A` with the bash tool, then reply DONE_A.";
export const OPENCODE2_STEER_TEXT = "Also mention the word STEERED in your final reply.";
export const OPENCODE2_QUEUED_PROMPT = "Reply exactly QUEUED_B.";
export const OPENCODE2_CANCELLED_PROMPT = "Reply exactly QUEUED_C.";
export const OPENCODE2_REVERT_FIRST_PROMPT =
  "Create a file named reverted.txt containing the word ALPHA using the write tool, then reply DONE.";
export const OPENCODE2_REVERT_SECOND_PROMPT =
  "Overwrite reverted.txt so it contains the word BETA using the write tool, then reply DONE.";
export const OPENCODE2_QUESTION_PROMPT =
  "Before doing anything, use the question tool to ask me which color I prefer, offering the options red and blue. After I answer, reply with only the chosen color.";
export const OPENCODE2_SUBAGENT_PROMPT =
  "Use the subagent tool to delegate to the explore subagent with the prompt: 'List the files in the current directory and report their names.' Wait for it, then summarize its answer in one line.";
export const OPENCODE2_NESTED_BACKGROUND_PROMPT =
  "Use the subagent tool (foreground, do not set background) to delegate to the general subagent with this exact prompt: 'Use the subagent tool with background set to true to delegate to the general subagent with the prompt: Run the shell command `sleep 25` with the shell tool, then reply exactly GRANDCHILD_OK. As soon as it is launched, reply exactly MIDDLE_OK and end your turn without waiting for it.' Wait for that subagent to return, then reply exactly ROOT_OK.";
export const OPENCODE2_BACKGROUND_PROMPT =
  "Use the subagent tool with background enabled to delegate to the general subagent with the prompt: 'Run the shell command `sleep 20` with the bash tool and then reply exactly CHILD_OK.' As soon as it is launched, reply exactly PARENT_OK and end your turn without waiting for it.";
export const OPENCODE2_COMPACTION_FIRST_PROMPT = "Remember the codeword PAPAYA. Reply OK.";
export const OPENCODE2_COMPACTION_RECALL_PROMPT = "What was the codeword? One word.";
export const OPENCODE2_RESTART_PROMPT =
  "Run the shell command `sleep 25 && echo RESUMED` with the bash tool, then reply with its output.";
export const OPENCODE2_RESTART_RECALL_PROMPT =
  "What did I last ask you to run? Answer in one short sentence.";
export const OPENCODE2_COMMAND_PROMPT = "/hello WORLD";
export const OPENCODE2_SKILL_PROMPT = "Use $greet to say hi in three words.";
