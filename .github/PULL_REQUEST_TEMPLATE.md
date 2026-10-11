### Description

<!-- REQUIRED
    Provide a concise description of your change. What does it do? Why is it necessary?
    As a guideline, think about how you would describe your change if you were to write a changelog entry for it.
-->

### Addressed Issue

<!-- REQUIRED
    Reference the issue addressed by this PR, e.g. `closes #1234`.
    Use keywords like `closes` or `fixes` to signal that this PR resolves the issue,
    so the issue is closed automatically when the PR is merged:
        https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword
    Documentation-only changes need no issue; write "docs" here.
-->

### Additional Details

<!-- OPTIONAL
    Share more technical details about the change here if you like.
    Elaborating on why you implemented the change the way you did can be very helpful to the reviewer.
    Did you consider other solutions? Any problems you ran into along the way?
-->

### Checklist

<!-- REQUIRED
    Mark items in this list as done by adding an `x` between the square brackets.
    Non-applicable items may be marked as such by surrounding their text with tildes (`~`).

    This is not meant to be a strict to-do list. If you are unsure about anything,
    just leave it empty for now. The maintainers are happy to help you figure it out!
-->

- [ ] I have read and understand the [contributing guidelines](../CONTRIBUTING.md#pull-requests), and my commits are signed off (DCO)
- [ ] This PR fixes a defect, and I have provided tests to verify that the fix is effective
- [ ] This PR implements an enhancement, and I have provided tests to verify that it works as intended
- [ ] This PR changes the database schema, and I have added a forward migration (`pnpm db:generate` in `server/` or `client/`) that works on a populated database
- [ ] This PR introduces new or alters existing behaviour, and I have updated the [documentation](../docs/self-hosting/) accordingly
- [ ] This PR touches nothing under `server/src/cloud/` or `client/src/cloud/`
