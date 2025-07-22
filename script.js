// 検索・フィルタ機能
document.addEventListener('DOMContentLoaded', function() {
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearch');
    const filterBtns = document.querySelectorAll('.filter-btn');
    const projectRows = document.querySelectorAll('.project-row');
    
    let currentFilter = 'all';
    let currentSearchTerm = '';
    
    // 検索履歴管理
    let searchHistory = JSON.parse(localStorage.getItem('searchHistory') || '[]');
    const maxHistoryItems = 10;
    
    // カテゴリ色の動的生成
    const categoryColors = [
        'linear-gradient(135deg, #3b82f6, #1e40af)',  // 青
        'linear-gradient(135deg, #8b5cf6, #6d28d9)',  // 紫
        'linear-gradient(135deg, #f59e0b, #d97706)',  // オレンジ
        'linear-gradient(135deg, #ef4444, #dc2626)',  // 赤
        'linear-gradient(135deg, #10b981, #059669)',  // 緑
        'linear-gradient(135deg, #06b6d4, #0891b2)',  // シアン
        'linear-gradient(135deg, #84cc16, #65a30d)',  // ライム
        'linear-gradient(135deg, #eab308, #ca8a04)',  // 黄色
        'linear-gradient(135deg, #f97316, #ea580c)',  // オレンジ2
        'linear-gradient(135deg, #ec4899, #db2777)',  // ピンク
        'linear-gradient(135deg, #6366f1, #4f46e5)',  // インディゴ
        'linear-gradient(135deg, #14b8a6, #0d9488)',  // ティール
    ];
    
    // カテゴリに色を自動割り当て（完全動的対応）
    function assignCategoryColors() {
        // 全カテゴリを収集
        const allCategories = new Set();
        projectRows.forEach(row => {
            const categories = row.getAttribute('data-category').split(',');
            categories.forEach(cat => allCategories.add(cat.trim()));
        });
        
        // カテゴリを配列に変換してソート
        const sortedCategories = Array.from(allCategories).sort();
        
        // 色マップを作成
        const categoryColorMap = {};
        sortedCategories.forEach((category, index) => {
            categoryColorMap[category] = categoryColors[index % categoryColors.length];
        });
        
        // 各プロジェクト行の色を設定
        projectRows.forEach(row => {
            const tags = row.querySelectorAll('.category-tag');
            tags.forEach(tag => {
                const categoryName = tag.textContent.trim();
                if (categoryColorMap[categoryName]) {
                    tag.style.background = categoryColorMap[categoryName];
                } else {
                    // フォールバック色
                    tag.style.background = categoryColors[0];
                }
            });
        });
        
        console.log('検出されたカテゴリ:', sortedCategories);
    }
    
    // ページ読み込み時に色を設定
    assignCategoryColors();

    // カテゴリタグのクリックリスナーを追加
    addCategoryTagListeners();

    // 検索機能
    searchInput.addEventListener('input', function() {
        currentSearchTerm = this.value.toLowerCase().trim();
        filterProjects();
        toggleClearButton();
        showSuggestions();
    });

    // Enterキーで検索履歴に追加
    searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const searchTerm = this.value.trim();
            if (searchTerm && !searchHistory.includes(searchTerm)) {
                searchHistory.unshift(searchTerm);
                if (searchHistory.length > maxHistoryItems) {
                    searchHistory = searchHistory.slice(0, maxHistoryItems);
                }
                localStorage.setItem('searchHistory', JSON.stringify(searchHistory));
            }
            hideSuggestions();
        } else if (e.key === 'Escape') {
            hideSuggestions();
            this.blur();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateSuggestions('down');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateSuggestions('up');
        }
    });

    // フォーカス時に履歴表示
    searchInput.addEventListener('focus', function() {
        if (searchHistory.length > 0) {
            showHistoryDropdown();
        }
    });

    // フォーカス外した時に履歴非表示
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.search-box')) {
            hideSuggestions();
        }
    });

    // 検索クリアボタン
    clearSearchBtn.addEventListener('click', function() {
        searchInput.value = '';
        currentSearchTerm = '';
        filterProjects();
        toggleClearButton();
        hideSuggestions();
        searchInput.focus();
    });

    // クリアボタンの表示/非表示
    function toggleClearButton() {
        clearSearchBtn.style.display = currentSearchTerm ? 'block' : 'none';
    }

    // カテゴリフィルタ
    filterBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            // アクティブボタンの切り替え
            filterBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            currentFilter = this.getAttribute('data-category');
            filterProjects();
        });
    });

    // カテゴリタグクリック機能
    function addCategoryTagListeners() {
        const categoryTags = document.querySelectorAll('.category-tag');
        categoryTags.forEach(tag => {
            tag.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                
                const categoryName = this.textContent.trim();
                
                // フィルタボタンのアクティブ状態を更新
                filterBtns.forEach(btn => {
                    btn.classList.remove('active');
                    if (btn.getAttribute('data-category') === categoryName) {
                        btn.classList.add('active');
                    }
                });
                
                // もしフィルタボタンが見つからない場合（新しいカテゴリの場合）
                let activeButtonFound = false;
                filterBtns.forEach(btn => {
                    if (btn.classList.contains('active')) {
                        activeButtonFound = true;
                    }
                });
                
                if (!activeButtonFound) {
                    // "全て"ボタンをアクティブにする
                    const allButton = document.querySelector('[data-category="all"]');
                    if (allButton) {
                        allButton.classList.add('active');
                    }
                }
                
                currentFilter = categoryName;
                filterProjects();
                
                // 検索フィールドをクリア（オプション）
                if (currentSearchTerm) {
                    searchInput.value = '';
                    currentSearchTerm = '';
                    toggleClearButton();
                }
            });
        });
    }

    // プロジェクトのフィルタリング（複数カテゴリ対応）
    function filterProjects() {
        let visibleCount = 0;
        
        projectRows.forEach(row => {
            const categories = row.getAttribute('data-category').split(','); // カンマで分割
            const searchData = row.getAttribute('data-search');
            const titleElement = row.querySelector('td:first-child a');
            const descriptionElement = row.querySelector('td:last-child');
            
            // カテゴリフィルタのチェック（複数カテゴリに対応）
            const categoryMatch = currentFilter === 'all' || 
                categories.some(cat => cat.trim() === currentFilter);
            
            // 拡張された検索フィルタのチェック
            let searchMatch = currentSearchTerm === '';
            if (currentSearchTerm !== '') {
                const titleText = titleElement ? titleElement.textContent.toLowerCase() : '';
                const descriptionText = descriptionElement ? descriptionElement.textContent.toLowerCase() : '';
                const categoryText = categories.join(' ').toLowerCase();
                const searchDataText = searchData.toLowerCase();
                
                searchMatch = titleText.includes(currentSearchTerm) ||
                             descriptionText.includes(currentSearchTerm) ||
                             categoryText.includes(currentSearchTerm) ||
                             searchDataText.includes(currentSearchTerm);
            }
            
            if (categoryMatch && searchMatch) {
                row.style.display = '';
                visibleCount++;
                // アニメーション効果
                row.style.animation = 'fadeIn 0.3s ease-in';
            } else {
                row.style.display = 'none';
            }
        });

        // 結果表示の更新
        updateResultsInfo(visibleCount);
    }

    // 検索結果情報の表示
    function updateResultsInfo(count) {
        let infoElement = document.querySelector('.results-info');
        if (!infoElement) {
            infoElement = document.createElement('div');
            infoElement.className = 'results-info';
            document.querySelector('.projects-table').insertBefore(infoElement, document.querySelector('.projects-list'));
        }

        if (currentSearchTerm || currentFilter !== 'all') {
            infoElement.textContent = `${count} 件の製作物が見つかりました`;
            infoElement.style.display = 'block';
        } else {
            infoElement.style.display = 'none';
        }
    }

    // 検索候補表示
    function showSuggestions() {
        const searchTerm = searchInput.value.toLowerCase().trim();
        if (searchTerm.length === 0) {
            if (searchHistory.length > 0) {
                showHistoryDropdown();
            }
            return;
        }

        // 現在のテキストに基づく候補を生成
        const suggestions = generateSuggestions(searchTerm);
        const filteredHistory = searchHistory.filter(item => 
            item.toLowerCase().includes(searchTerm));

        const allSuggestions = [...new Set([...suggestions, ...filteredHistory])].slice(0, 8);
        
        if (allSuggestions.length > 0) {
            showSuggestionsDropdown(allSuggestions);
        } else {
            hideSuggestions();
        }
    }

    // 履歴ドロップダウン表示
    function showHistoryDropdown() {
        const recentHistory = searchHistory.slice(0, 5);
        if (recentHistory.length > 0) {
            showSuggestionsDropdown(recentHistory, true);
        }
    }

    // 候補の生成
    function generateSuggestions(searchTerm) {
        const suggestions = new Set();
        
        projectRows.forEach(row => {
            const titleElement = row.querySelector('td:first-child a');
            const descriptionElement = row.querySelector('td:last-child');
            const categories = row.getAttribute('data-category').split(',');
            
            if (titleElement) {
                const title = titleElement.textContent.toLowerCase();
                if (title.includes(searchTerm)) {
                    suggestions.add(titleElement.textContent);
                }
            }
            
            if (descriptionElement) {
                const description = descriptionElement.textContent.toLowerCase();
                if (description.includes(searchTerm) && description.trim()) {
                    suggestions.add(descriptionElement.textContent.trim());
                }
            }
            
            categories.forEach(cat => {
                const category = cat.trim().toLowerCase();
                if (category.includes(searchTerm)) {
                    suggestions.add(cat.trim());
                }
            });
        });
        
        return Array.from(suggestions);
    }

    // 候補ドロップダウン表示
    function showSuggestionsDropdown(suggestions, isHistory = false) {
        hideSuggestions(); // 既存の候補を削除
        
        const dropdown = document.createElement('div');
        dropdown.className = 'search-suggestions';
        dropdown.setAttribute('data-is-history', isHistory);
        
        if (isHistory && suggestions.length > 0) {
            const header = document.createElement('div');
            header.className = 'suggestions-header';
            header.textContent = '最近の検索';
            dropdown.appendChild(header);
        }
        
        suggestions.forEach((suggestion, index) => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.textContent = suggestion;
            item.setAttribute('data-index', index);
            
            item.addEventListener('click', function() {
                searchInput.value = suggestion;
                currentSearchTerm = suggestion.toLowerCase().trim();
                filterProjects();
                toggleClearButton();
                hideSuggestions();
                
                // 履歴に追加
                if (!searchHistory.includes(suggestion)) {
                    searchHistory.unshift(suggestion);
                    if (searchHistory.length > maxHistoryItems) {
                        searchHistory = searchHistory.slice(0, maxHistoryItems);
                    }
                    localStorage.setItem('searchHistory', JSON.stringify(searchHistory));
                }
            });
            
            dropdown.appendChild(item);
        });
        
        document.querySelector('.search-box').appendChild(dropdown);
    }

    // 候補非表示
    function hideSuggestions() {
        const existing = document.querySelector('.search-suggestions');
        if (existing) {
            existing.remove();
        }
        selectedSuggestionIndex = -1;
    }

    // 候補ナビゲーション
    let selectedSuggestionIndex = -1;
    
    function navigateSuggestions(direction) {
        const dropdown = document.querySelector('.search-suggestions');
        if (!dropdown) return;
        
        const items = dropdown.querySelectorAll('.suggestion-item');
        if (items.length === 0) return;
        
        // 前の選択をクリア
        if (selectedSuggestionIndex >= 0) {
            items[selectedSuggestionIndex].classList.remove('selected');
        }
        
        if (direction === 'down') {
            selectedSuggestionIndex = (selectedSuggestionIndex + 1) % items.length;
        } else {
            selectedSuggestionIndex = selectedSuggestionIndex <= 0 ? 
                items.length - 1 : selectedSuggestionIndex - 1;
        }
        
        // 新しい選択をハイライト
        items[selectedSuggestionIndex].classList.add('selected');
        
        // 選択されたアイテムを検索フィールドにプレビュー
        searchInput.value = items[selectedSuggestionIndex].textContent;
    }

    // 初期状態でクリアボタンを非表示
    toggleClearButton();

    // キーボードショートカット
    document.addEventListener('keydown', function(e) {
        // Ctrl+F または Cmd+F で検索フォーカス
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            searchInput.focus();
        }
        
        // Escape で検索クリア
        if (e.key === 'Escape' && document.activeElement === searchInput) {
            clearSearchBtn.click();
        }
    });

    // スムーズスクロール（将来的なページ内リンク用）
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
});
