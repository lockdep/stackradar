import { describe, expect, it } from "vitest";
import { csvCell, csvDocument } from "../../../src/lib/csv.js";

describe("csvCell", () => {
    it("writes plain text, numbers and booleans as they are, and nothing for null", () => {
        expect(csvCell("lodash")).toBe("lodash");
        expect(csvCell(9.8)).toBe("9.8");
        expect(csvCell(0)).toBe("0");
        expect(csvCell(true)).toBe("true");
        expect(csvCell(false)).toBe("false");
        expect(csvCell(null)).toBe("");
        expect(csvCell(undefined)).toBe("");
        expect(csvCell(Number.NaN)).toBe("");
    });

    it("quotes a cell holding a comma, a quote or a line break, doubling the quotes", () => {
        expect(csvCell("a, b")).toBe('"a, b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell("two\nlines")).toBe('"two\nlines"');
        expect(csvCell(" padded ")).toBe('" padded "');
    });

    it("marks a cell a spreadsheet would evaluate as text", () => {
        expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
        expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
        expect(csvCell("+1")).toBe("'+1");
        expect(csvCell("-1")).toBe("'-1");
        // A negative *number* is a number, not a formula.
        expect(csvCell(-1)).toBe("-1");
    });
});

describe("csvDocument", () => {
    it("opens with a byte-order mark and ends every line, the last included, with CRLF", () => {
        const doc = csvDocument(
            ["a", "b"],
            [
                ["1", "x,y"],
                [null, "z"],
            ],
        );
        expect(doc).toBe('\uFEFFa,b\r\n1,"x,y"\r\n,z\r\n');
    });

    it("is a header alone when there are no rows", () => {
        expect(csvDocument(["a"], [])).toBe("\uFEFFa\r\n");
    });
});
