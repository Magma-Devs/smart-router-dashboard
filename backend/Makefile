.PHONY: format check-format tests install-dev

# Install development dependencies
install-dev:
	pip install -r requirements.txt -r requirements-dev.txt

# Format Python code with Black
format:
	black app/ tests/

# Check if code is formatted correctly
check-format:
	black --check app/ tests/

# Run tests with coverage
tests:
	pytest --cov=app --cov-report=term-missing

# Run tests quietly
tests-quiet:
	pytest -q

# Run specific test file
test-file:
	@test -n "$(FILE)" || (echo "Usage: make test-file FILE=path/to/test.py" && exit 1)
	pytest $(FILE) -v
