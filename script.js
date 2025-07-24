// 検索・フィルタ・ページネーション統合機能
document.addEventListener('DOMContentLoaded', function() {
    // ページ判定
    const isProjectPage = document.querySelector('.projects-table') !== null;
    const isBlogPage = document.querySelector('.articles-grid') !== null;
    
    // 基本要素の取得
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearch');
    const filterBtns = document.querySelectorAll('.filter-btn');
    
    // ページに応じて対象要素を取得
    let targetItems;
    if (isProjectPage) {
        targetItems = document.querySelectorAll('.project-row');
    } else if (isBlogPage) {
        targetItems = document.querySelectorAll('.article-card');
    } else {
        return; // 対象ページでない場合は終了
    }
    
    // ページネーション要素（上下両方）
    const paginationContainers = document.querySelectorAll('.pagination-container');
    const paginationInfoTop = document.getElementById('paginationInfoTop');
    const paginationInfoBottom = document.getElementById('paginationInfoBottom');
    const paginationNumbersTop = document.getElementById('paginationNumbersTop');
    const paginationNumbersBottom = document.getElementById('paginationNumbersBottom');
    const prevPageTopBtn = document.getElementById('prevPageTop');
    const nextPageTopBtn = document.getElementById('nextPageTop');
    const prevPageBottomBtn = document.getElementById('prevPageBottom');
    const nextPageBottomBtn = document.getElementById('nextPageBottom');
    const pageSizeTopSelect = document.getElementById('pageSizeTop');
    const pageSizeBottomSelect = document.getElementById('pageSizeBottom');
    
    // 後方互換性のための旧要素（残っている場合）
    const paginationInfo = document.getElementById('paginationInfo');
    const paginationNumbers = document.getElementById('paginationNumbers');
    const prevPageBtn = document.getElementById('prevPage');
    const nextPageBtn = document.getElementById('nextPage');
    const pageSizeSelect = document.getElementById('pageSize');
    
    // 状態管理
    let currentFilter = 'all';
    let currentSearchTerm = '';
    let currentPage = 1;
    let pageSize = 10;
    
    // ページネーション機能が利用可能かチェック
    const paginationEnabled = !!(paginationContainers.length > 0 && (paginationInfoTop || paginationInfo) && (paginationNumbersTop || paginationNumbers));
    
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
        targetItems.forEach(item => {
            let categories;
            if (isProjectPage) {
                categories = item.getAttribute('data-category').split(',');
            } else if (isBlogPage) {
                categories = item.getAttribute('data-categories').split(',');
            }
            categories.forEach(cat => allCategories.add(cat.trim()));
        });
        
        // カテゴリを配列に変換してソート
        const sortedCategories = Array.from(allCategories).sort();
        
        // 色マップを作成
        const categoryColorMap = {};
        sortedCategories.forEach((category, index) => {
            categoryColorMap[category] = categoryColors[index % categoryColors.length];
        });
        
        // 各アイテムの色を設定
        targetItems.forEach(item => {
            const tags = item.querySelectorAll('.category-tag');
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
    
    // フィルタされた行を取得
    function getFilteredRows() {
        return Array.from(targetItems).filter(item => {
            let categories, searchData, titleElement, descriptionElement;
            
            if (isProjectPage) {
                categories = item.getAttribute('data-category').split(',');
                searchData = item.getAttribute('data-search');
                titleElement = item.querySelector('td:first-child a');
                descriptionElement = item.querySelector('td:last-child');
            } else if (isBlogPage) {
                categories = item.getAttribute('data-categories').split(',');
                searchData = item.getAttribute('data-search');
                titleElement = item.querySelector('.article-title a');
                descriptionElement = item.querySelector('.article-summary');
            }
            
            // カテゴリフィルタのチェック（複数カテゴリに対応）
            const categoryMatch = currentFilter === 'all' || 
                categories.some(cat => cat.trim() === currentFilter);
            
            // 拡張された検索フィルタのチェック
            let searchMatch = currentSearchTerm === '';
            if (currentSearchTerm !== '') {
                const titleText = titleElement ? titleElement.textContent.toLowerCase() : '';
                const descriptionText = descriptionElement ? descriptionElement.textContent.toLowerCase() : '';
                const categoryText = categories.join(' ').toLowerCase();
                const searchDataText = searchData ? searchData.toLowerCase() : '';
                
                searchMatch = titleText.includes(currentSearchTerm) ||
                             descriptionText.includes(currentSearchTerm) ||
                             categoryText.includes(currentSearchTerm) ||
                             searchDataText.includes(currentSearchTerm);
            }
            
            return categoryMatch && searchMatch;
        });
    }
    
    // プロジェクト表示の更新
    function updateProjectDisplay() {
        const filteredRows = getFilteredRows();
        const totalItems = filteredRows.length;
        
        // 全アイテムをまず非表示にする
        targetItems.forEach(item => {
            item.style.display = 'none';
        });
        
        if (paginationEnabled && totalItems > 0) {
            // ページネーション有効時
            const totalPages = Math.ceil(totalItems / pageSize);
            
            // ページ数の調整
            if (currentPage > totalPages && totalPages > 0) {
                currentPage = totalPages;
            }
            if (currentPage < 1) {
                currentPage = 1;
            }
            
            // 現在ページのアイテムを表示
            const startIndex = (currentPage - 1) * pageSize;
            const endIndex = Math.min(startIndex + pageSize, totalItems);
            
            for (let i = startIndex; i < endIndex; i++) {
                if (filteredRows[i]) {
                    filteredRows[i].style.display = '';
                    filteredRows[i].style.animation = 'fadeIn 0.3s ease-in';
                }
            }
            
            // ページネーション更新
            updatePaginationInfo(totalItems);
            updatePaginationControls(totalPages);
            
            // ページネーションコンテナの表示制御を改善
            // 常にページネーションコンテナは表示し、個別要素の表示を制御
            paginationContainer.style.display = 'flex';
            
            // ページ制御部分（番号、前後ボタン）の表示制御
            const paginationControls = paginationContainer.querySelector('.pagination');
            if (paginationControls) {
                if (totalPages <= 1) {
                    paginationControls.style.display = 'none';
                } else {
                    paginationControls.style.display = 'flex';
                }
            }
        } else if (paginationEnabled) {
            // ページネーション有効だが項目がない場合
            filteredRows.forEach(item => {
                item.style.display = '';
                item.style.animation = 'fadeIn 0.3s ease-in';
            });
            
            // ページネーションコンテナは表示し、制御部分のみ非表示
            paginationContainer.style.display = 'flex';
            const paginationControls = paginationContainer.querySelector('.pagination');
            if (paginationControls) {
                paginationControls.style.display = 'none';
            }
            
            updatePaginationInfo(totalItems);
        } else {
            // ページネーション無効時は全て表示
            filteredRows.forEach(item => {
                item.style.display = '';
                item.style.animation = 'fadeIn 0.3s ease-in';
            });
        }
        
        // 結果表示の更新
        updateResultsInfo(totalItems);
    }
    
    // ページネーション情報を更新
    function updatePaginationInfo(totalItems) {
        const infoText = totalItems === 0 ? '0件' : 
                        totalItems <= pageSize ? `全 ${totalItems}件` :
                        `${(currentPage - 1) * pageSize + 1}-${Math.min(currentPage * pageSize, totalItems)} / ${totalItems}件`;
        
        // 上下両方の情報を更新
        if (paginationInfoTop) paginationInfoTop.textContent = infoText;
        if (paginationInfoBottom) paginationInfoBottom.textContent = infoText;
        // 後方互換性のため
        if (paginationInfo) paginationInfo.textContent = infoText;
    }
    
    // ページネーション制御の更新
    function updatePaginationControls(totalPages) {
        // 上下両方のページ番号をクリア
        if (paginationNumbersTop) paginationNumbersTop.innerHTML = '';
        if (paginationNumbersBottom) paginationNumbersBottom.innerHTML = '';
        if (paginationNumbers) paginationNumbers.innerHTML = '';
        
        // ページネーションコンテナを取得
        const paginationDivs = document.querySelectorAll('.pagination-container .pagination');
        
        if (totalPages <= 1) {
            // ページ数が1以下の場合は制御ボタンを非表示
            paginationDivs.forEach(div => {
                if (div) div.style.display = 'none';
            });
            
            // 全ボタンを無効化
            [prevPageTopBtn, nextPageTopBtn, prevPageBottomBtn, nextPageBottomBtn, prevPageBtn, nextPageBtn]
                .forEach(btn => { if (btn) btn.disabled = true; });
            return;
        }
        
        // ページ制御ボタンを表示
        paginationDivs.forEach(div => {
            if (div) div.style.display = 'flex';
        });
        
        const maxVisiblePages = 5;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
        
        // 表示ページ数が足りない場合の調整
        if (endPage - startPage + 1 < maxVisiblePages) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }
        
        // 上下両方にページ番号を追加
        [paginationNumbersTop, paginationNumbersBottom, paginationNumbers].forEach(container => {
            if (!container) return;
            
            // 最初のページ
            if (startPage > 1) {
                const firstBtn = createPageButton(1);
                container.appendChild(firstBtn);
                
                if (startPage > 2) {
                    const ellipsis = document.createElement('span');
                    ellipsis.textContent = '...';
                    ellipsis.className = 'pagination-ellipsis';
                    container.appendChild(ellipsis);
                }
            }
            
            // メインのページ番号
            for (let i = startPage; i <= endPage; i++) {
                const pageBtn = createPageButton(i);
                container.appendChild(pageBtn);
            }
            
            // 最後のページ
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) {
                    const ellipsis = document.createElement('span');
                    ellipsis.textContent = '...';
                    ellipsis.className = 'pagination-ellipsis';
                    container.appendChild(ellipsis);
                }
                
                const lastBtn = createPageButton(totalPages);
                container.appendChild(lastBtn);
            }
        });
        
        // 前後ボタンの状態更新
        const isFirstPage = currentPage <= 1;
        const isLastPage = currentPage >= totalPages;
        
        [prevPageTopBtn, prevPageBottomBtn, prevPageBtn].forEach(btn => {
            if (btn) btn.disabled = isFirstPage;
        });
        
        [nextPageTopBtn, nextPageBottomBtn, nextPageBtn].forEach(btn => {
            if (btn) btn.disabled = isLastPage;
        });
    }
    
    // ページボタンを作成
    function createPageButton(pageNumber) {
        const btn = document.createElement('button');
        btn.className = 'pagination-number';
        btn.textContent = pageNumber;
        btn.setAttribute('data-page', pageNumber);
        
        if (pageNumber === currentPage) {
            btn.classList.add('active');
        }
        
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            goToPage(pageNumber);
        });
        
        return btn;
    }
    
    // 指定ページに移動
    function goToPage(pageNumber) {
        currentPage = pageNumber;
        updateProjectDisplay();
    }
    
    // カテゴリタグのクリックリスナーを追加
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
                currentPage = 1; // フィルタ変更時は1ページ目に戻る
                updateProjectDisplay();
                
                // 検索フィールドをクリア（オプション）
                if (currentSearchTerm) {
                    searchInput.value = '';
                    currentSearchTerm = '';
                    toggleClearButton();
                }
            });
        });
    }
    
    // 検索結果情報の表示
    function updateResultsInfo(count) {
        let infoElement = document.querySelector('.results-info');
        if (!infoElement) {
            infoElement = document.createElement('div');
            infoElement.className = 'results-info';
            
            if (isProjectPage) {
                // プロジェクトページでは上部ページネーションの後に挿入
                const topPagination = document.querySelector('.pagination-container.pagination-top');
                const projectsTable = document.querySelector('.projects-table');
                if (topPagination && projectsTable) {
                    projectsTable.insertBefore(infoElement, projectsTable.firstElementChild);
                } else if (projectsTable) {
                    projectsTable.insertBefore(infoElement, document.querySelector('.projects-list'));
                }
            } else if (isBlogPage) {
                // ブログページでは上部ページネーションの後に挿入
                const topPagination = document.querySelector('.pagination-container.pagination-top');
                const articlesGrid = document.querySelector('.articles-grid');
                if (topPagination && articlesGrid && topPagination.nextElementSibling) {
                    topPagination.parentNode.insertBefore(infoElement, topPagination.nextElementSibling);
                } else if (articlesGrid) {
                    const blogContent = document.querySelector('.blog-content');
                    if (blogContent) {
                        blogContent.insertBefore(infoElement, articlesGrid);
                    }
                }
            }
        }

        if (currentSearchTerm || currentFilter !== 'all') {
            const itemType = isProjectPage ? '製作物' : 'ブログ記事';
            infoElement.textContent = `${count} 件の${itemType}が見つかりました`;
            infoElement.style.display = 'block';
        } else {
            infoElement.style.display = 'none';
        }
    }
    
    // クリアボタンの表示/非表示
    function toggleClearButton() {
        if (clearSearchBtn) {
            clearSearchBtn.style.display = currentSearchTerm ? 'block' : 'none';
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
        
        targetItems.forEach(item => {
            let titleElement, descriptionElement, categories;
            
            if (isProjectPage) {
                titleElement = item.querySelector('td:first-child a');
                descriptionElement = item.querySelector('td:last-child');
                categories = item.getAttribute('data-category').split(',');
            } else if (isBlogPage) {
                titleElement = item.querySelector('.article-title a');
                descriptionElement = item.querySelector('.article-summary');
                categories = item.getAttribute('data-categories').split(',');
            }
            
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
                currentPage = 1; // 検索時は1ページ目に戻る
                updateProjectDisplay();
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
        
        const searchBox = document.querySelector('.search-box');
        if (searchBox) {
            searchBox.appendChild(dropdown);
        }
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
    
    // イベントリスナーの設定
    
    // 検索機能
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            currentSearchTerm = this.value.toLowerCase().trim();
            currentPage = 1; // 検索時は1ページ目に戻る
            updateProjectDisplay();
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
    }
    
    // 検索クリアボタン
    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', function() {
            searchInput.value = '';
            currentSearchTerm = '';
            currentPage = 1;
            updateProjectDisplay();
            toggleClearButton();
            hideSuggestions();
            searchInput.focus();
        });
    }

    // カテゴリフィルタ
    filterBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            // アクティブボタンの切り替え
            filterBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            currentFilter = this.getAttribute('data-category');
            currentPage = 1; // フィルタ変更時は1ページ目に戻る
            updateProjectDisplay();
        });
    });
    
    // ページネーションのイベントリスナー
    if (paginationEnabled) {
        
        // ページサイズ選択（上下両方と後方互換性）
        [pageSizeTopSelect, pageSizeBottomSelect, pageSizeSelect].forEach(select => {
            if (select) {
                // 初期値設定
                if (!pageSize) pageSize = parseInt(select.value || 10);
                
                select.addEventListener('change', function() {
                    pageSize = parseInt(this.value);
                    currentPage = 1; // ページサイズ変更時は1ページ目に戻る
                    
                    // 他の選択ボックスも同期
                    [pageSizeTopSelect, pageSizeBottomSelect, pageSizeSelect].forEach(otherSelect => {
                        if (otherSelect && otherSelect !== this) {
                            otherSelect.value = this.value;
                        }
                    });
                    
                    updateProjectDisplay();
                });
            }
        });
        
        // 前後ボタンのイベントリスナー（上下両方と後方互換性）
        [prevPageTopBtn, prevPageBottomBtn, prevPageBtn].forEach(btn => {
            if (btn) {
                btn.addEventListener('click', function() {
                    if (currentPage > 1) {
                        currentPage--;
                        updateProjectDisplay();
                    }
                });
            }
        });
        
        [nextPageTopBtn, nextPageBottomBtn, nextPageBtn].forEach(btn => {
            if (btn) {
                btn.addEventListener('click', function() {
                    const filteredRows = getFilteredRows();
                    const totalPages = Math.ceil(filteredRows.length / pageSize);
                    if (currentPage < totalPages) {
                        currentPage++;
                        updateProjectDisplay();
                    }
                });
            }
        });
    }
    
    // フォーカス外した時に履歴非表示
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.search-box')) {
            hideSuggestions();
        }
    });

    // キーボードショートカット
    document.addEventListener('keydown', function(e) {
        // Ctrl+F または Cmd+F で検索フォーカス
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            if (searchInput) {
                searchInput.focus();
            }
        }
        
        // Escape で検索クリア
        if (e.key === 'Escape' && document.activeElement === searchInput) {
            if (clearSearchBtn) {
                clearSearchBtn.click();
            }
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
    
    // 初期化
    assignCategoryColors();
    addCategoryTagListeners();
    toggleClearButton();
    
    // 初期表示の更新
    setTimeout(function() {
        updateProjectDisplay();
    }, 100);
});
