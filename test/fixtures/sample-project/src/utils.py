import os
import subprocess

def read_file(path):
    with open(path, 'r') as f:
        return f.read()

def run_command(cmd):
    """Execute a shell command and return output."""
    return subprocess.check_output(cmd, shell=True).decode()

def get_env(key, default=None):
    return os.environ.get(key, default)
