# Ask another agent

- Discover the target project and its workflows with `wfe projects`. A delegate node entrusts work to a child run. `wfe delegate help` describes request, status, questions and result operations.
- Give the child the requested result and useful context. Preserve the person's words and distinguish your interpretation from them.
- Wait in WFE records, not a sleeping background process. Whether a child may run beside you on the same node is warden's decision, not yours to assume; end the attempt when only recorded waits remain, and its continuation resumes you.
- `wfe delegate show` shows the child's questions, results and available assessment. Take up new facts and relay questions to the person with `wfe run ask` when their answer is needed.
- Compare the child's claims with its actual files and verification before reporting success. Say what you could not inspect. Your judgement and the person's acceptance are different facts.
- A result that names a shared output declares it; it is not delivered to you until `wfe delegate verify` says VERIFIED here and you record what you use (`wfe run input`). When the assessment says the output is UNAVAILABLE here (`delivery-unverified`), wait for the share or say you could not verify it. If you judge from another source instead (for example the producer's Git commit), name that source in the note: it is not a verified consumption of the publication.
- `wfe delegate revise` returns missing or defective work to the same child. Replacing a child is a separate decision. Stopping the parent does not automatically cancel the child.
- If another run requested your work, deliver to that requester as this attempt specifies. Give it enough evidence and accessible results to serve the person it represents.
