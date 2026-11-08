"""Reuse sealed LSP format contracts and exercise additive provider handoffs."""
from cli0156.lsp_contracts import run as lsp_contracts
from handoff_contracts import run as handoff_contracts

def run(context):
    lsp_contracts(context)
    handoff_contracts(context)
