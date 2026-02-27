// Simple floating calculator widget
const Calculator = {
    expression: '',
    justEvaluated: false,

    open() {
        App.openModal('calculator-modal');
        this.updateDisplay();
    },

    append(val) {
        if (this.justEvaluated && /[0-9\.]/.test(val)) {
            this.expression = '';
        }
        this.justEvaluated = false;

        // Prevent double operators
        const last = this.expression.slice(-1);
        const isOp = v => '+-×÷%'.includes(v);
        if (isOp(val) && isOp(last) && last !== '') {
            this.expression = this.expression.slice(0, -1) + val;
        } else {
            this.expression += val;
        }
        this.updateDisplay();
    },

    clear() {
        this.expression = '';
        this.justEvaluated = false;
        this.updateDisplay();
    },

    backspace() {
        this.expression = this.expression.slice(0, -1);
        this.justEvaluated = false;
        this.updateDisplay();
    },

    calculate() {
        if (!this.expression) return;
        try {
            // Replace display symbols with JS operators
            let expr = this.expression
                .replace(/×/g, '*')
                .replace(/÷/g, '/')
                .replace(/--/g, '+')
                .replace(/[^0-9+\-*/%.()]/g, '');

            // Safety: only allow valid characters
            if (!/^[0-9+\-*/%.() ]+$/.test(expr)) {
                this.updateDisplay('Error');
                return;
            }

            // eslint-disable-next-line no-new-func
            const result = Function('"use strict"; return (' + expr + ')')();

            if (!isFinite(result)) {
                this.expression = 'Error';
            } else {
                this.expression = parseFloat(result.toFixed(8)).toString();
            }
            this.justEvaluated = true;
        } catch (e) {
            this.expression = 'Error';
        }
        this.updateDisplay();
    },

    updateDisplay(override = null) {
        const disp = document.getElementById('calc-display');
        if (disp) disp.textContent = override || this.expression || '0';
    },
};

document.addEventListener('DOMContentLoaded', () => {
    // Calculator open button
    document.getElementById('calculator-btn')?.addEventListener('click', () => Calculator.open());

    // Keyboard support while calculator is open
    document.addEventListener('keydown', (e) => {
        const calcModal = document.getElementById('calculator-modal');
        if (!calcModal?.classList.contains('active')) return;

        const key = e.key;
        if (key >= '0' && key <= '9') Calculator.append(key);
        else if (key === '+') Calculator.append('+');
        else if (key === '-') Calculator.append('-');
        else if (key === '*') Calculator.append('×');
        else if (key === '/') { e.preventDefault(); Calculator.append('÷'); }
        else if (key === '%') Calculator.append('%');
        else if (key === '.') Calculator.append('.');
        else if (key === 'Enter' || key === '=') Calculator.calculate();
        else if (key === 'Backspace') Calculator.backspace();
        else if (key === 'Escape') App.closeModal('calculator-modal');
        else if (key === 'c' || key === 'C') Calculator.clear();
    });
});
