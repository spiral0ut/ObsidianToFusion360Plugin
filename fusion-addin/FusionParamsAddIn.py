
# FusionParamsAddIn.py (v0.2.0)
import adsk.core, adsk.fusion, adsk.cam, traceback, json, os, pathlib

_app = None
_ui = None
_handlers = []

# Path where the bridge config is stored (shared between Obsidian and Fusion)
CONFIG_PATH = os.path.join(str(pathlib.Path.home()), '.fusion_obsidian_bridge.json')


# ---------- vault config helpers ----------

def load_bridge_config():
    try:
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    except Exception:
        return {}

def save_bridge_config(cfg):
    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(cfg, f, indent=2)
        return True
    except Exception:
        return False

def get_vault_params_path(design_name):
    """Returns the expected JSON path in the vault, or None if vault not configured."""
    cfg = load_bridge_config()
    vault = cfg.get('vault_path', '').strip()
    folder = (cfg.get('params_folder', 'Params') or 'Params').strip()
    if not vault:
        return None
    return os.path.join(vault, folder, f'{design_name}.json')


# ---------- param helpers ----------

def make_value_string(val, unit):
    try:
        if unit:
            return f"{val} {unit}"
        return str(val)
    except:
        return str(val)

def upsert_user_param(userParams, name, expr_or_val, default_unit='', comment=None):
    existing = None
    for p in userParams:
        if p.name == name:
            existing = p
            break

    if isinstance(expr_or_val, str):
        expr = expr_or_val
    else:
        expr = make_value_string(expr_or_val, default_unit)

    if existing:
        existing.expression = expr
        if comment is not None:
            existing.comment = comment
    else:
        vi = adsk.core.ValueInput.createByString(expr)
        userParams.add(name, vi, default_unit or '', comment or '')

def apply_params_from_json(path):
    global _app, _ui
    try:
        design = adsk.fusion.Design.cast(_app.activeProduct)
        if not design:
            _ui.messageBox('No active Fusion design.')
            return

        with open(path, 'r') as f:
            payload = json.load(f)

        default_unit = payload.get('defaultUnit', '')
        params = payload.get('parameters', [])
        for p in params:
            name = p.get('name')
            comment = p.get('comment')
            if 'expression' in p:
                upsert_user_param(design.userParameters, name, p['expression'], '', comment)
            else:
                val = p.get('value')
                unit = p.get('unit', default_unit)
                upsert_user_param(design.userParameters, name, val, unit, comment)
        _ui.messageBox(f'Applied {len(params)} parameter(s) from:\n{path}')
    except:
        _ui.messageBox('Failed to apply params:\n{}'.format(traceback.format_exc()))

def export_params_to_json(path):
    global _app, _ui
    try:
        design = adsk.fusion.Design.cast(_app.activeProduct)
        if not design:
            _ui.messageBox('No active Fusion design.')
            return
        out = {
            "design": design.parentDocument.name if design.parentDocument else "ActiveDesign",
            "defaultUnit": "",
            "parameters": []
        }
        for p in design.userParameters:
            out["parameters"].append({
                "name": p.name,
                "expression": p.expression,
                "comment": p.comment or ""
            })
        with open(path, 'w') as f:
            json.dump(out, f, indent=2)
        _ui.messageBox(f'Exported {len(out["parameters"])} parameter(s) to:\n{path}')
    except:
        _ui.messageBox('Failed to export params:\n{}'.format(traceback.format_exc()))


# ---------- command handlers ----------

class ConfigVaultCommandExecuteHandler(adsk.core.CommandEventHandler):
    """One-time setup: tell Fusion where your Obsidian vault lives."""
    def __init__(self):
        super().__init__()
    def notify(self, args):
        try:
            cfg = load_bridge_config()

            (vault_path, cancelled) = _ui.inputBox(
                'Enter the full path to your Obsidian vault folder\n'
                '(e.g.  C:\\Users\\you\\Documents\\MyVault  or  /Users/you/Documents/MyVault):',
                'Obsidian Vault Path',
                cfg.get('vault_path', '')
            )
            if cancelled:
                return
            vault_path = vault_path.strip()
            if not vault_path:
                _ui.messageBox('No path entered. Config unchanged.')
                return

            (params_folder, cancelled) = _ui.inputBox(
                'Params subfolder inside the vault where JSON files live\n'
                '(must match the Output Folder set in the Obsidian plugin settings):',
                'Params Subfolder',
                cfg.get('params_folder', 'Params')
            )
            if cancelled:
                return
            params_folder = params_folder.strip() or 'Params'

            cfg['vault_path'] = vault_path
            cfg['params_folder'] = params_folder
            if save_bridge_config(cfg):
                _ui.messageBox(
                    f'Vault configured!\n\n'
                    f'Vault:  {vault_path}\n'
                    f'Params folder:  {params_folder}\n\n'
                    f'Import/Export will now use this path automatically.'
                )
            else:
                _ui.messageBox(f'Could not write config to:\n{CONFIG_PATH}')
        except:
            _ui.messageBox('Error (Config Vault):\n{}'.format(traceback.format_exc()))


class ImportParamsCommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()
    def notify(self, args):
        try:
            design = adsk.fusion.Design.cast(_app.activeProduct)
            if not design:
                _ui.messageBox('No active Fusion design.')
                return

            design_name = design.parentDocument.name if design.parentDocument else None
            auto_path = get_vault_params_path(design_name) if design_name else None

            if auto_path and os.path.isfile(auto_path):
                apply_params_from_json(auto_path)
            else:
                # Fall back to file dialog (vault not configured, or file doesn't exist yet)
                fileDlg = _ui.createFileDialog()
                fileDlg.isMultiSelectEnabled = False
                fileDlg.title = 'Select JSON Parameter File'
                fileDlg.filter = 'JSON files (*.json)'
                if auto_path:
                    fileDlg.initialDirectory = os.path.dirname(auto_path)
                if fileDlg.showOpen() != adsk.core.DialogResults.DialogOK:
                    return
                apply_params_from_json(fileDlg.filename)
        except:
            _ui.messageBox('Error (Import execute):\n{}'.format(traceback.format_exc()))


class ExportParamsCommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()
    def notify(self, args):
        try:
            design = adsk.fusion.Design.cast(_app.activeProduct)
            if not design:
                _ui.messageBox('No active Fusion design.')
                return

            design_name = design.parentDocument.name if design.parentDocument else None
            auto_path = get_vault_params_path(design_name) if design_name else None

            if auto_path:
                os.makedirs(os.path.dirname(auto_path), exist_ok=True)
                export_params_to_json(auto_path)
            else:
                # Fall back to file dialog (vault not configured)
                fileDlg = _ui.createFileDialog()
                fileDlg.isMultiSelectEnabled = False
                fileDlg.title = 'Save Parameters to JSON'
                fileDlg.filter = 'JSON files (*.json)'
                if fileDlg.showSave() != adsk.core.DialogResults.DialogOK:
                    return
                export_params_to_json(fileDlg.filename)
        except:
            _ui.messageBox('Error (Export execute):\n{}'.format(traceback.format_exc()))


class CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, execute_handler):
        super().__init__()
        self._execute_handler = execute_handler
    def notify(self, args):
        try:
            cmd = args.command
            cmd.execute.add(self._execute_handler)
            _handlers.append(self._execute_handler)
        except:
            _ui.messageBox('Error (commandCreated):\n{}'.format(traceback.format_exc()))

def add_command(cmd_id, cmd_name, cmd_desc, execute_handler_cls):
    cmdDef = _ui.commandDefinitions.itemById(cmd_id)
    if not cmdDef:
        cmdDef = _ui.commandDefinitions.addButtonDefinition(cmd_id, cmd_name, cmd_desc)
    onExecute = execute_handler_cls()
    onCreated = CommandCreatedHandler(onExecute)
    cmdDef.commandCreated.add(onCreated)
    _handlers.extend([onExecute, onCreated])
    ws = _ui.workspaces.itemById('FusionSolidEnvironment')
    panel = ws.toolbarPanels.itemById('SolidScriptsAddinsPanel')
    if panel and not panel.controls.itemById(cmd_id):
        panel.controls.addCommand(cmdDef)

def run(context):
    global _app, _ui
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface
        add_command('FusionParamsConfigVault', 'Configure Obsidian Vault', 'Set vault path for automatic JSON sync', ConfigVaultCommandExecuteHandler)
        add_command('FusionParamsImport', 'Import Params from JSON', 'Create/update user parameters from JSON', ImportParamsCommandExecuteHandler)
        add_command('FusionParamsExport', 'Export Params to JSON', 'Save current user parameters to JSON', ExportParamsCommandExecuteHandler)
    except:
        if _ui:
            _ui.messageBox('Add-in start failed:\n{}'.format(traceback.format_exc()))

def stop(context):
    global _ui
    try:
        ws = _ui.workspaces.itemById('FusionSolidEnvironment')
        panel = ws.toolbarPanels.itemById('SolidScriptsAddinsPanel')
        for cmd_id in ['FusionParamsConfigVault', 'FusionParamsImport', 'FusionParamsExport']:
            if panel:
                ctrl = panel.controls.itemById(cmd_id)
                if ctrl: ctrl.deleteMe()
            cmd = _ui.commandDefinitions.itemById(cmd_id)
            if cmd: cmd.deleteMe()
    except:
        pass
